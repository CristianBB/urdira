import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseSync } from "@babel/core";

const manifestRelativePath = "architecture/manifest.json";
const workspaceRoots = ["apps", "packages"];
const sourceExtensions = new Set([".cjs", ".cts", ".js", ".mjs", ".mts", ".ts", ".tsx"]);

export async function loadArchitectureManifest(repositoryRoot) {
  const manifestPath = join(repositoryRoot, manifestRelativePath);
  const contents = await readFile(manifestPath, "utf8");
  try {
    return JSON.parse(contents);
  } catch {
    return { parseError: "Architecture manifest is not valid JSON" };
  }
}

export async function checkArchitecture(repositoryRoot, manifest) {
  const errors = [];
  if (!isRecord(manifest)) {
    return {
      errors: ["Architecture manifest must be an object"],
      checkedPackages: [],
    };
  }

  if (typeof manifest.parseError === "string") {
    errors.push(manifest.parseError);
  }
  if (manifest.version !== 1) {
    errors.push("Architecture manifest version must be 1");
  }
  if (!Array.isArray(manifest.packages)) {
    errors.push("Architecture manifest packages must be an array");
  }

  const rawEntries = Array.isArray(manifest.packages) ? manifest.packages : [];
  const entries = [];
  const entriesByName = new Map();
  const entriesByPath = new Map();

  for (const entry of rawEntries) {
    if (!isPackageEntry(entry)) {
      errors.push("Architecture manifest contains an invalid package entry");
      continue;
    }

    entries.push(entry);
    if (entriesByName.has(entry.name)) {
      errors.push(`Architecture manifest contains duplicate package ${entry.name}`);
    }
    if (entriesByPath.has(entry.path)) {
      errors.push(`Architecture manifest contains duplicate path ${entry.path}`);
    }
    entriesByName.set(entry.name, entry);
    entriesByPath.set(entry.path, entry);
  }

  const workspacePackages = await discoverWorkspacePackages(repositoryRoot);
  const checkedPackages = workspacePackages.map((workspacePackage) => workspacePackage.name);

  for (const workspacePackage of workspacePackages) {
    const relativePath = relative(repositoryRoot, workspacePackage.path);
    const entry = entriesByPath.get(relativePath);
    if (!entry) {
      errors.push(`Package ${workspacePackage.name} is not covered by the architecture manifest`);
      continue;
    }
    if (entry.name !== workspacePackage.name) {
      errors.push(
        `Manifest path ${entry.path} names ${entry.name}, but package.json declares ${workspacePackage.name}`,
      );
    }
    errors.push(...checkDependencies(workspacePackage, entry));
    errors.push(
      ...(await checkSourceImports(
        repositoryRoot,
        workspacePackage,
        entry,
        entriesByName,
        workspacePackages,
      )),
    );
  }

  for (const entry of entries) {
    const packageJsonPath = join(repositoryRoot, entry.path, "package.json");
    if (!existsSync(packageJsonPath)) {
      errors.push(`Manifest package ${entry.name} is missing ${entry.path}/package.json`);
    }
    for (const dependencyName of entry.dependencies) {
      const dependency = entriesByName.get(dependencyName);
      if (!dependency) {
        errors.push(`${entry.name} allows dependency ${dependencyName}, which is not in the manifest`);
      } else if (dependency.layer >= entry.layer) {
        errors.push(
          `${entry.name} depends on ${dependencyName} without moving toward a lower architecture layer`,
        );
      }
    }
  }

  errors.push(...checkCoverage(manifest.coverage, entriesByName));
  errors.push(...(await checkSourceProviderCommandIsolation(repositoryRoot)));
  errors.push(...(await checkPluginPhaseBoundaries(repositoryRoot, workspacePackages)));

  return { errors, checkedPackages };
}

const languageWorkerName = /(?:^(?:create)?(?:JavaScript|TypeScript|Rust).*(?:Worker|Plugin)$)|(?:^(?:Worker|Plugin).*(?:JavaScript|TypeScript|Rust)$)/u;
const laterPhasePluginOperationName = /^(?:QueryEngine|(?:execute|run|search)Query|(?:publish|commit)(?:Snapshot|Generation|Candidate|Canonical)|assignGeneration|CandidateOrchestrator|Publication)/u;
const arbitraryCommandTypeName = /(?:Command(?:Runner|Executor|Port)|Shell(?:Runner|Executor|Port)|Arbitrary(?:Process|Launcher))/u;

export async function checkPluginPhaseBoundaries(repositoryRoot, workspacePackages) {
  const errors = [];
  const packages = workspacePackages ?? await discoverWorkspacePackages(repositoryRoot);
  for (const workspacePackage of packages) {
    const sourceFiles = await findSourceFiles(join(workspacePackage.path, "src"));
    const sourceByFile = new Map(await Promise.all(sourceFiles.map(async (sourceFile) => [
      sourceFile,
      await readFile(sourceFile, "utf8"),
    ])));
    const exportedSurfaceFor = workspacePackage.name === "@urdira/plugin-sdk"
      ? createPackageExportedSurfaceResolver(sourceByFile)
      : (sourceFile) => parseExportedSurface(sourceByFile.get(sourceFile) ?? "", sourceFile);
    for (const sourceFile of sourceFiles) {
      const sourcePath = relative(repositoryRoot, sourceFile);
      const exportedSurface = exportedSurfaceFor(sourceFile);
      const exportedNames = exportedSurface.names;

      if (workspacePackage.name !== "@urdira/testkit") {
        for (const name of exportedNames) {
          if (languageWorkerName.test(name)) {
            errors.push(`${sourcePath} production packages cannot export language-shaped worker ${name}`);
          }
        }
      }

      if (workspacePackage.name !== "@urdira/plugin-sdk") continue;
      for (const name of exportedNames) {
        if (laterPhasePluginOperationName.test(name)) {
          errors.push(`${sourcePath} plugin SDK cannot export later-phase operation ${name}`);
        }
      }

      for (const name of exportedNames) {
        if (arbitraryCommandTypeName.test(name)) {
          errors.push(`${sourcePath} plugin sandbox cannot expose arbitrary command port ${name}`);
        }
      }
      if (exportedSurface.acceptsArbitraryCommand) {
        errors.push(`${sourcePath} plugin sandbox cannot accept an arbitrary command string`);
      }
      for (const name of exportedSurface.sourceWriteNames) {
        errors.push(`${sourcePath} plugin sandbox cannot expose source-write authority ${name}`);
      }
    }
  }
  return errors;
}

function emptyExportedSurface() {
  return { names: [], sourceWriteNames: [], acceptsArbitraryCommand: false };
}

function mergeExportedSurface(target, source) {
  for (const name of source.names) target.names.add(name);
  for (const name of source.sourceWriteNames) target.sourceWriteNames.add(name);
  if (source.acceptsArbitraryCommand) target.acceptsArbitraryCommand = true;
}

function resolvePackageSourceFile(sourceFile, specifier, sourceByFile) {
  if (!specifier.startsWith(".")) return undefined;
  const unresolved = resolve(dirname(sourceFile), specifier);
  const unresolvedExtension = extname(unresolved);
  const stem = unresolvedExtension.length > 0 ? unresolved.slice(0, -unresolvedExtension.length) : unresolved;
  const candidates = new Set([unresolved]);
  for (const extension of sourceExtensions) {
    candidates.add(`${stem}${extension}`);
    if (unresolvedExtension.length === 0) candidates.add(`${unresolved}${extension}`);
    candidates.add(join(unresolved, `index${extension}`));
  }
  return [...candidates].find((candidate) => sourceByFile.has(candidate));
}

function createPackageExportedSurfaceResolver(sourceByFile) {
  const cache = new Map();
  const active = new Set();
  const astByFile = new Map();
  const astFor = (sourceFile) => {
    const source = sourceByFile.get(sourceFile);
    if (source !== undefined && !astByFile.has(sourceFile)) {
      astByFile.set(sourceFile, parseSourceAst(source, sourceFile));
    }
    return astByFile.get(sourceFile);
  };
  const identifierName = (node) => node?.type === "Identifier" ? node.name
    : node?.type === "StringLiteral" ? node.value
      : undefined;
  const declarationNames = (declaration) => {
    const names = [];
    const name = identifierName(declaration?.id);
    if (name !== undefined) names.push(name);
    if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations ?? []) {
        const itemName = identifierName(item.id);
        if (itemName !== undefined) names.push(itemName);
      }
    }
    return names;
  };
  const originDetails = new Map();
  const localBindingOrigin = (sourceFile, localName) => {
    const origin = `${sourceFile}\u0000local\u0000${localName}`;
    originDetails.set(origin, { kind: "local", sourceFile, localName });
    return origin;
  };
  const exportBindingOrigin = (sourceFile, exportName) => {
    const origin = `${sourceFile}\u0000export\u0000${exportName}`;
    originDetails.set(origin, { kind: "export", sourceFile, exportName });
    return origin;
  };
  const explicitNamesByFile = new Map();
  const baseProvenanceByFile = new Map();
  const namedReexportsByFile = new Map();
  const starTargetsByFile = new Map();
  for (const sourceFile of sourceByFile.keys()) {
    const explicitNames = new Set();
    const baseProvenance = new Map();
    const namedReexports = [];
    const starTargets = [];
    const importedBindings = new Map();
    for (const statement of astFor(sourceFile)?.program.body ?? []) {
      if (statement.type !== "ImportDeclaration") continue;
      const targetFile = resolvePackageSourceFile(sourceFile, statement.source.value, sourceByFile);
      if (targetFile === undefined) continue;
      for (const specifier of statement.specifiers) {
        const localName = identifierName(specifier.local);
        if (localName === undefined || specifier.type === "ImportNamespaceSpecifier") continue;
        const targetName = specifier.type === "ImportDefaultSpecifier"
          ? "default"
          : identifierName(specifier.imported);
        if (targetName !== undefined) importedBindings.set(localName, { targetFile, targetName });
      }
    }
    for (const statement of astFor(sourceFile)?.program.body ?? []) {
      if (statement.type === "ExportNamedDeclaration") {
        for (const name of declarationNames(statement.declaration)) {
          explicitNames.add(name);
          baseProvenance.set(name, new Set([localBindingOrigin(sourceFile, name)]));
        }
        for (const specifier of statement.specifiers) {
          const exportedName = identifierName(specifier.exported);
          if (exportedName === undefined) continue;
          explicitNames.add(exportedName);
          if (statement.source === null || statement.source === undefined) {
            const localName = identifierName(specifier.local) ?? exportedName;
            const importedBinding = importedBindings.get(localName);
            if (importedBinding === undefined) {
              baseProvenance.set(exportedName, new Set([localBindingOrigin(sourceFile, localName)]));
            } else {
              namedReexports.push({ exportedName, ...importedBinding });
            }
            continue;
          }
          const targetFile = resolvePackageSourceFile(sourceFile, statement.source.value, sourceByFile);
          if (targetFile === undefined) continue;
          if (specifier.type === "ExportNamespaceSpecifier") {
            baseProvenance.set(exportedName, new Set([exportBindingOrigin(sourceFile, exportedName)]));
          } else {
            const targetName = identifierName(specifier.local);
            if (targetName !== undefined) namedReexports.push({ exportedName, targetFile, targetName });
          }
        }
      } else if (statement.type === "ExportDefaultDeclaration") {
        explicitNames.add("default");
        baseProvenance.set("default", new Set([exportBindingOrigin(sourceFile, "default")]));
      } else if (statement.type === "ExportAllDeclaration") {
        const exportedName = identifierName(statement.exported);
        const targetFile = resolvePackageSourceFile(sourceFile, statement.source.value, sourceByFile);
        if (exportedName !== undefined) {
          explicitNames.add(exportedName);
          if (targetFile !== undefined) {
            baseProvenance.set(exportedName, new Set([exportBindingOrigin(sourceFile, exportedName)]));
          }
        } else if (targetFile !== undefined) {
          starTargets.push(targetFile);
        }
      }
    }
    explicitNamesByFile.set(sourceFile, explicitNames);
    baseProvenanceByFile.set(sourceFile, baseProvenance);
    namedReexportsByFile.set(sourceFile, namedReexports);
    starTargetsByFile.set(sourceFile, starTargets);
  }
  const mergeOrigins = (target, name, origins) => {
    if (!target.has(name)) target.set(name, new Set());
    let changed = false;
    for (const origin of origins) {
      if (target.get(name).has(origin)) continue;
      target.get(name).add(origin);
      changed = true;
    }
    return changed;
  };
  const exportProvenanceByFile = new Map([...sourceByFile.keys()].map((sourceFile) => [
    sourceFile,
    new Map([...baseProvenanceByFile.get(sourceFile)].map(([name, origins]) => [name, new Set(origins)])),
  ]));
  let provenanceChanged = true;
  while (provenanceChanged) {
    provenanceChanged = false;
    for (const sourceFile of sourceByFile.keys()) {
      const provenance = exportProvenanceByFile.get(sourceFile);
      for (const { exportedName, targetFile, targetName } of namedReexportsByFile.get(sourceFile) ?? []) {
        const targetOrigins = exportProvenanceByFile.get(targetFile)?.get(targetName);
        if (targetOrigins !== undefined && mergeOrigins(provenance, exportedName, targetOrigins)) {
          provenanceChanged = true;
        }
      }
      const explicitNames = explicitNamesByFile.get(sourceFile) ?? new Set();
      for (const targetFile of starTargetsByFile.get(sourceFile) ?? []) {
        for (const [name, origins] of exportProvenanceByFile.get(targetFile) ?? []) {
          if (name !== "default" && !explicitNames.has(name) && mergeOrigins(provenance, name, origins)) {
            provenanceChanged = true;
          }
        }
      }
    }
  }
  const resolvedOriginsByFile = new Map([...exportProvenanceByFile].map(([sourceFile, provenance]) => [
    sourceFile,
    new Map([...provenance].filter(([, origins]) => origins.size === 1)),
  ]));
  const exportOriginsFor = (sourceFile) => resolvedOriginsByFile.get(sourceFile) ?? new Map();
  const exportProvenanceFor = (sourceFile) => exportProvenanceByFile.get(sourceFile) ?? new Map();
  const resolveSurface = (
    sourceFile,
    requestedExportNames,
    includeDefault = true,
    requestedTypeArguments = new Map(),
    requestedLocalTypeArguments = new Map(),
  ) => {
    const requestedKey = requestedExportNames === undefined ? "*" : [...requestedExportNames].sort().join("\u0000");
    const argumentsKey = [...requestedTypeArguments]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, arguments_]) => `${name}:${arguments_.map((argument) => argument.isString ? "string" : "other").join(",")}`)
      .join("\u0000");
    const localArgumentsKey = [...requestedLocalTypeArguments]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, arguments_]) => `${name}:${arguments_.map((argument) => argument.isString ? "string" : "other").join(",")}`)
      .join("\u0000");
    const cacheKey = `${sourceFile}\u0000${includeDefault ? "default" : "named"}\u0000${requestedKey}\u0000${argumentsKey}\u0000${localArgumentsKey}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    if (active.has(cacheKey)) return emptyExportedSurface();
    active.add(cacheKey);
    const source = sourceByFile.get(sourceFile);
    const surface = source === undefined ? emptyExportedSurface() : parseExportedSurface(source, sourceFile, {
      ast: astFor(sourceFile),
      requestedExportNames,
      requestedTypeArguments,
      requestedLocalTypeArguments,
      includeDefault,
      resolveExportNames(specifier) {
        const targetFile = resolvePackageSourceFile(sourceFile, specifier, sourceByFile);
        return targetFile === undefined ? new Set() : new Set(exportOriginsFor(targetFile).keys());
      },
      resolveExportOrigins(specifier) {
        const targetFile = resolvePackageSourceFile(sourceFile, specifier, sourceByFile);
        return targetFile === undefined ? new Map() : exportProvenanceFor(targetFile);
      },
      resolveExport(specifier, targetExportNames, targetIncludeDefault = true, targetTypeArguments = new Map()) {
        const targetFile = resolvePackageSourceFile(sourceFile, specifier, sourceByFile);
        if (targetFile === undefined) return emptyExportedSurface();
        const selectedNames = targetExportNames ?? new Set(exportOriginsFor(targetFile).keys());
        const merged = { names: new Set(), sourceWriteNames: new Set(), acceptsArbitraryCommand: false };
        for (const name of selectedNames) {
          if (name === "default" && !targetIncludeDefault) continue;
          const origins = exportOriginsFor(targetFile).get(name);
          if (origins === undefined || origins.size !== 1) continue;
          const origin = originDetails.get([...origins][0]);
          if (origin === undefined) continue;
          if (origin.kind === "local") {
            const localTypeArguments = targetTypeArguments.has(name)
              ? new Map([[origin.localName, targetTypeArguments.get(name)]])
              : new Map([[origin.localName, []]]);
            mergeExportedSurface(merged, resolveSurface(
              origin.sourceFile,
              new Set(),
              false,
              new Map(),
              localTypeArguments,
            ));
            continue;
          }
          const typeArguments = targetTypeArguments.has(name)
            ? new Map([[origin.exportName, targetTypeArguments.get(name)]])
            : new Map();
          mergeExportedSurface(merged, resolveSurface(
            origin.sourceFile,
            new Set([origin.exportName]),
            origin.exportName === "default",
            typeArguments,
          ));
        }
        return { names: [...merged.names], sourceWriteNames: [...merged.sourceWriteNames], acceptsArbitraryCommand: merged.acceptsArbitraryCommand };
      },
    });
    active.delete(cacheKey);
    cache.set(cacheKey, surface);
    return surface;
  };
  return (sourceFile) => resolveSurface(sourceFile, undefined, true);
}

function parseSourceAst(source, sourceFile) {
  return parseSync(source, {
    filename: sourceFile,
    sourceType: "module",
    parserOpts: { plugins: extname(sourceFile) === ".tsx" ? ["typescript", "jsx"] : ["typescript"] },
  });
}

function parseExportedSurface(source, sourceFile, options = {}) {
  const names = new Set();
  const sourceWriteNames = new Set();
  const surface = { names, sourceWriteNames, acceptsArbitraryCommand: false };
  const requestedExportNames = options.requestedExportNames;
  const requestedTypeArguments = options.requestedTypeArguments ?? new Map();
  const requestedLocalTypeArguments = options.requestedLocalTypeArguments ?? new Map();
  const wantsExport = (name) => requestedExportNames === undefined || requestedExportNames.has(name);
  const resolveExport = options.resolveExport ?? (() => emptyExportedSurface());
  const resolveExportNames = options.resolveExportNames ?? (() => new Set());
  const resolveExportOrigins = options.resolveExportOrigins ?? ((specifier) =>
    new Map([...resolveExportNames(specifier)].map((name) => [name, new Set([`${specifier}\u0000${name}`])])));
  const ast = options.ast ?? parseSourceAst(source, sourceFile);
  if (ast === null) return emptyExportedSurface();

  const identifierName = (node) => node?.type === "Identifier" ? node.name
    : node?.type === "StringLiteral" ? node.value
      : undefined;
  const declarationNames = (declaration) => {
    const found = [];
    if (declaration === null || declaration === undefined) return found;
    const name = identifierName(declaration.id);
    if (name !== undefined) found.push(name);
    if (declaration.type === "VariableDeclaration") {
      for (const item of declaration.declarations ?? []) {
        const itemName = identifierName(item.id);
        if (itemName !== undefined) found.push(itemName);
      }
    }
    return found;
  };
  const declarations = new Map();
  const imports = new Map();
  for (const statement of ast.program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
      ? statement.declaration
      : statement;
    if (declaration === null || declaration === undefined) continue;
    const declaredNames = declarationNames(declaration);
    if (declaredNames.length === 0) continue;
    for (const name of declaredNames) declarations.set(name, declaration);
  }
  for (const statement of ast.program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers) {
      const localName = identifierName(specifier.local);
      if (localName === undefined) continue;
      if (specifier.type === "ImportNamespaceSpecifier") {
        imports.set(localName, { source: statement.source.value, namespace: true });
      } else if (specifier.type === "ImportDefaultSpecifier") {
        imports.set(localName, { source: statement.source.value, importedName: "default" });
      } else {
        const importedName = identifierName(specifier.imported);
        if (importedName !== undefined) imports.set(localName, { source: statement.source.value, importedName });
      }
    }
  }

  const callableNodeTypes = new Set([
    "ClassMethod", "ClassPrivateMethod", "ObjectMethod", "TSMethodSignature", "TSDeclareFunction",
    "FunctionDeclaration", "FunctionExpression",
  ]);
  const callableNameFor = (node) => {
    if (callableNodeTypes.has(node.type)) return identifierName(node.key) ?? identifierName(node.id);
    if (node.type === "TSPropertySignature" && node.typeAnnotation?.typeAnnotation?.type === "TSFunctionType") {
      return identifierName(node.key);
    }
    if (node.type === "VariableDeclarator" && ["ArrowFunctionExpression", "FunctionExpression"].includes(node.init?.type)) {
      return identifierName(node.id);
    }
    if (node.type === "ObjectProperty" && ["ArrowFunctionExpression", "FunctionExpression"].includes(node.value?.type)) {
      return identifierName(node.key);
    }
    return undefined;
  };
  const typeParametersFor = (declaration) => declaration.typeParameters?.params ?? [];
  const typeArgumentsFor = (reference) => reference?.typeParameters?.params ?? reference?.typeArguments?.params ?? [];
  const bindTypeParameters = (declaration, reference, bindings) => {
    const nextBindings = new Map(bindings);
    const parameters = typeParametersFor(declaration);
    const arguments_ = typeArgumentsFor(reference);
    const resolvedArguments = reference?.resolvedTypeArguments ?? [];
    for (let index = 0; index < parameters.length; index += 1) {
      const parameterName = typeof parameters[index]?.name === "string"
        ? parameters[index].name
        : identifierName(parameters[index]?.name ?? parameters[index]);
      if (parameterName === undefined) continue;
      if (resolvedArguments[index] !== undefined) {
        nextBindings.set(parameterName, resolvedArguments[index]);
        continue;
      }
      if (arguments_[index] !== undefined) {
        nextBindings.set(parameterName, { node: arguments_[index], bindings, sourceFile });
        continue;
      }
      const fallback = parameters[index]?.default ?? parameters[index]?.constraint;
      if (!nextBindings.has(parameterName) && fallback !== null && fallback !== undefined) {
        nextBindings.set(parameterName, { node: fallback, bindings: nextBindings, sourceFile });
      }
    }
    return nextBindings;
  };
  const isStringType = (node, bindings = new Map(), aliasStack = new Set(), bindingStack = new Set()) => {
    if (node === null || typeof node !== "object") return false;
    if (node.type === "TSStringKeyword") return true;
    if (node.type === "TSLiteralType") return node.literal?.type === "StringLiteral";
    if (node.type === "TSParenthesizedType" || node.type === "TSOptionalType") {
      return isStringType(node.typeAnnotation, bindings, aliasStack, bindingStack);
    }
    if (node.type === "TSUnionType" || node.type === "TSIntersectionType") {
      return node.types.some((part) => isStringType(part, bindings, aliasStack, bindingStack));
    }
    if (node.type !== "TSTypeReference") return false;
    const referenceName = identifierName(node.typeName);
    if (referenceName === undefined) return false;
    const binding = bindings.get(referenceName);
    if (binding !== undefined) {
      if (binding.isString) return true;
      if (bindingStack.has(binding)) return false;
      bindingStack.add(binding);
      const result = isStringType(binding.node, binding.bindings, aliasStack, bindingStack);
      bindingStack.delete(binding);
      return result;
    }
    const declaration = declarations.get(referenceName);
    if (declaration?.type !== "TSTypeAliasDeclaration" || aliasStack.has(declaration)) return false;
    aliasStack.add(declaration);
    const aliasBindings = bindTypeParameters(declaration, node, bindings);
    const result = isStringType(declaration.typeAnnotation, aliasBindings, aliasStack, bindingStack);
    aliasStack.delete(declaration);
    return result;
  };
  const inspectAuthority = (node, bindings) => {
    const callableName = callableNameFor(node);
    if (callableName !== undefined && /^(?:writeSource|mutateSource|updateSource)$/u.test(callableName)) {
      sourceWriteNames.add(callableName);
    }
    if (callableName !== undefined && /^(?:run|execute|spawn|launch)$/u.test(callableName)) {
      const signature = node.type === "TSPropertySignature" ? node.typeAnnotation?.typeAnnotation : node;
      const first = (signature?.params ?? signature?.parameters)?.[0];
      const parameterName = identifierName(first);
      const annotation = first?.typeAnnotation?.typeAnnotation;
      if ((parameterName === "command" || parameterName === "executable") && isStringType(annotation, bindings)) {
        surface.acceptsArbitraryCommand = true;
      }
    }
  };

  const activeDeclarations = new Set();
  const authorityMemberNodeTypes = new Set([
    "ClassMethod", "ObjectMethod", "ObjectProperty", "TSMethodSignature", "TSPropertySignature",
  ]);
  const callableWithImplementation = new Set([
    "ArrowFunctionExpression", "ClassMethod", "ClassPrivateMethod", "FunctionDeclaration", "FunctionExpression", "ObjectMethod",
  ]);
  const isPrivateMember = (node) => node.type === "ClassPrivateMethod"
    || node.key?.type === "PrivateName"
    || node.accessibility === "private";
  const semanticBindingsKey = (bindings) => [...bindings]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, binding]) => {
      if (binding.isString) return `${name}=string`;
      const bindingFile = binding.sourceFile ?? sourceFile;
      return `${name}=${bindingFile}:${binding.node?.type ?? "unknown"}:${binding.node?.start ?? "?"}:${binding.node?.end ?? "?"}`;
    })
    .join("|");
  const activeReachableTypes = new Set();
  let currentDeclaration = undefined;
  const walkDeclaration = (declaration, bindings, resolvedTypeArguments) => {
    const declarationBindings = bindTypeParameters(
      declaration,
      resolvedTypeArguments === undefined ? undefined : { resolvedTypeArguments },
      bindings,
    );
    const declarationKey = `${sourceFile}\u0000${declaration.type}:${declaration.start}:${declaration.end}\u0000${semanticBindingsKey(declarationBindings)}\u0000declaration`;
    if (activeDeclarations.has(declarationKey)) return;
    activeDeclarations.add(declarationKey);
    const previousDeclaration = currentDeclaration;
    currentDeclaration = declaration;
    for (const name of declarationNames(declaration)) names.add(name);
    walkReachableType(declaration, declarationBindings);
    currentDeclaration = previousDeclaration;
    activeDeclarations.delete(declarationKey);
  };
  const walkReachableType = (node, bindings = new Map()) => {
    if (node === null || typeof node !== "object") return;
    if (isPrivateMember(node)) return;
    let reachableKey;
    if (bindings.size > 0) {
      const semanticPosition = currentDeclaration === undefined
        ? "export"
        : `${currentDeclaration.type}:${currentDeclaration.start}:${currentDeclaration.end}`;
      reachableKey = `${sourceFile}\u0000${semanticPosition}\u0000${node.type}:${node.start}:${node.end}\u0000${semanticBindingsKey(bindings)}\u0000reachable`;
      if (activeReachableTypes.has(reachableKey)) return;
      activeReachableTypes.add(reachableKey);
    }
    const callableName = callableNameFor(node);
    if (callableName !== undefined && authorityMemberNodeTypes.has(node.type)) names.add(callableName);
    inspectAuthority(node, bindings);
    if (node.type === "TSTypeReference" || node.type === "TSExpressionWithTypeArguments") {
      const referenceName = identifierName(node.typeName ?? node.expression);
      const binding = referenceName === undefined ? undefined : bindings.get(referenceName);
      if (binding !== undefined) {
        if (!binding.isString) walkReachableType(binding.node, binding.bindings);
      } else if (referenceName !== undefined) {
        const imported = imports.get(referenceName);
        if (imported !== undefined && !imported.namespace) {
          const resolvedArguments = typeArgumentsFor(node).map((argument) => ({
            isString: isStringType(argument, bindings),
            node: argument,
            bindings,
            sourceFile,
          }));
          mergeExportedSurface(surface, resolveExport(
            imported.source,
            new Set([imported.importedName]),
            imported.importedName === "default",
            new Map([[imported.importedName, resolvedArguments]]),
          ));
        } else {
          const declaration = declarations.get(referenceName);
          if (declaration !== undefined) walkDeclaration(declaration, bindings, typeArgumentsFor(node).map((argument) => ({
            isString: isStringType(argument, bindings),
            node: argument,
            bindings,
            sourceFile,
          })));
        }
      }
    }
    if (node.type === "TSTypeReference" && node.typeName?.type === "TSQualifiedName") {
      const namespaceName = identifierName(node.typeName.left);
      const importedName = identifierName(node.typeName.right);
      const imported = namespaceName === undefined ? undefined : imports.get(namespaceName);
      if (imported?.namespace === true && importedName !== undefined) {
        const resolvedArguments = typeArgumentsFor(node).map((argument) => ({
          isString: isStringType(argument, bindings),
          node: argument,
          bindings,
          sourceFile,
        }));
        mergeExportedSurface(surface, resolveExport(
          imported.source,
          new Set([importedName]),
          false,
          new Map([[importedName, resolvedArguments]]),
        ));
      }
    }
    if (node.type === "Identifier") {
      const binding = bindings.get(node.name);
      if (binding !== undefined) {
        walkReachableType(binding.node, binding.bindings);
      } else {
        const declaration = declarations.get(node.name);
        if (declaration !== undefined) walkDeclaration(declaration, bindings);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end", "leadingComments", "trailingComments", "innerComments"].includes(key)) continue;
      if (key === "body" && callableWithImplementation.has(node.type)) continue;
      if (Array.isArray(value)) for (const child of value) walkReachableType(child, bindings);
      else if (value !== null && typeof value === "object") walkReachableType(value, bindings);
    }
    if (reachableKey !== undefined) activeReachableTypes.delete(reachableKey);
  };

  for (const [localName, typeArguments] of requestedLocalTypeArguments) {
    const declaration = declarations.get(localName);
    if (declaration !== undefined) walkDeclaration(declaration, new Map(), typeArguments);
  }

  for (const statement of ast.program.body) {
    if (statement.type === "ExportNamedDeclaration") {
      const declaredNames = declarationNames(statement.declaration);
      for (const name of declaredNames) if (wantsExport(name)) names.add(name);
      if (statement.declaration !== null) {
        for (const name of declaredNames) {
          if (wantsExport(name)) walkDeclaration(statement.declaration, new Map(), requestedTypeArguments.get(name));
        }
      }
      for (const specifier of statement.specifiers) {
        const exportedName = identifierName(specifier.exported);
        if (exportedName === undefined || !wantsExport(exportedName)) continue;
        names.add(exportedName);
        if (statement.source !== null && statement.source !== undefined) {
          if (specifier.type === "ExportNamespaceSpecifier") {
            mergeExportedSurface(surface, resolveExport(statement.source.value, undefined, true));
          } else {
            const targetName = identifierName(specifier.local);
            if (targetName !== undefined) mergeExportedSurface(surface, resolveExport(
              statement.source.value,
              new Set([targetName]),
              true,
              requestedTypeArguments.has(exportedName)
                ? new Map([[targetName, requestedTypeArguments.get(exportedName)]])
                : new Map(),
            ));
          }
          continue;
        }
        const localName = identifierName(specifier.local);
        if (localName === undefined) continue;
        names.add(localName);
        const imported = imports.get(localName);
        if (imported !== undefined && !imported.namespace) {
          mergeExportedSurface(surface, resolveExport(
            imported.source,
            new Set([imported.importedName]),
            imported.importedName === "default",
            requestedTypeArguments.has(exportedName)
              ? new Map([[imported.importedName, requestedTypeArguments.get(exportedName)]])
              : new Map(),
          ));
          continue;
        }
        const localDeclaration = declarations.get(localName);
        if (localDeclaration !== undefined) walkDeclaration(
          localDeclaration,
          new Map(),
          requestedTypeArguments.get(exportedName),
        );
      }
    } else if (statement.type === "ExportDefaultDeclaration") {
      if (options.includeDefault === false || !wantsExport("default")) continue;
      for (const name of declarationNames(statement.declaration)) names.add(name);
      const defaultArguments = requestedTypeArguments.get("default");
      if (declarationNames(statement.declaration).length > 0) {
        walkDeclaration(statement.declaration, new Map(), defaultArguments);
      } else {
        walkReachableType(statement.declaration, new Map());
      }
    } else if (statement.type === "ExportAllDeclaration") {
      const exportedName = identifierName(statement.exported);
      if (exportedName !== undefined) {
        if (!wantsExport(exportedName)) continue;
        names.add(exportedName);
        mergeExportedSurface(surface, resolveExport(statement.source.value, undefined, true));
      } else {
        const targetNames = resolveExportNames(statement.source.value);
        const explicitNames = new Set();
        const starNameOrigins = new Map();
        for (const candidate of ast.program.body) {
          if (candidate.type === "ExportNamedDeclaration") {
            for (const name of declarationNames(candidate.declaration)) explicitNames.add(name);
            for (const specifier of candidate.specifiers) {
              const name = identifierName(specifier.exported);
              if (name !== undefined) explicitNames.add(name);
            }
          } else if (candidate.type === "ExportAllDeclaration" && candidate.exported !== null && candidate.exported !== undefined) {
            const name = identifierName(candidate.exported);
            if (name !== undefined) explicitNames.add(name);
          }
        }
        for (const candidate of ast.program.body) {
          if (candidate.type !== "ExportAllDeclaration" || (candidate.exported !== null && candidate.exported !== undefined)) continue;
          for (const [name, origins] of resolveExportOrigins(candidate.source.value)) {
            if (name !== "default" && !explicitNames.has(name)) {
              if (!starNameOrigins.has(name)) starNameOrigins.set(name, new Set());
              for (const origin of origins) starNameOrigins.get(name).add(origin);
            }
          }
        }
        const selectedNames = new Set([...targetNames].filter((name) =>
          starNameOrigins.get(name)?.size === 1 && !explicitNames.has(name) && wantsExport(name)));
        if (selectedNames.size > 0) {
          mergeExportedSurface(surface, resolveExport(statement.source.value, selectedNames, false));
        }
      }
    }
  }
  return { names: [...names], sourceWriteNames: [...sourceWriteNames], acceptsArbitraryCommand: surface.acceptsArbitraryCommand };
}

const commandExecutionModules = new Set([
  "child_process",
  "node:child_process",
  "cross-spawn",
  "execa",
  "shelljs",
  "zx",
]);

export async function checkSourceProviderCommandIsolation(repositoryRoot) {
  const errors = [];
  const engineSource = join(repositoryRoot, "packages/engine/src");
  const sourceFiles = (await findSourceFiles(engineSource)).filter((sourceFile) => /provider(?:s)?\.[cm]?[jt]sx?$/u.test(basename(sourceFile)));
  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, "utf8");
    const sourcePath = relative(repositoryRoot, sourceFile);
    for (const specifier of findImportSpecifiers(source)) {
      const rootSpecifier = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      if (commandExecutionModules.has(specifier) || (rootSpecifier !== undefined && commandExecutionModules.has(rootSpecifier))) {
        errors.push(`${sourcePath} source providers cannot import command-execution module ${specifier}`);
      }
    }
    const commandPort = /\b(?:command(?:_port|Port)|shell(?:_port|Port)|process(?:_runner|Runner)|command(?:_runner|Runner|_executor|Executor))\b/u.exec(source)?.[0];
    if (commandPort) errors.push(`${sourcePath} source providers cannot declare or use command execution port ${commandPort}`);
    if (/(?<!\.)\b(?:exec|execFile|execSync|execFileSync|spawn|spawnSync|fork)\s*\(/u.test(source) || /\b(?:Deno|Bun)\.(?:Command|spawn)\b/u.test(source)) {
      errors.push(`${sourcePath} source providers cannot invoke operating-system commands`);
    }
  }
  return errors;
}

function isPackageEntry(entry) {
  return (
    isRecord(entry) &&
    typeof entry.name === "string" &&
    entry.name.length > 0 &&
    typeof entry.path === "string" &&
    entry.path.length > 0 &&
    Number.isInteger(entry.layer) &&
    entry.layer >= 0 &&
    Array.isArray(entry.dependencies) &&
    entry.dependencies.every((dependency) => typeof dependency === "string")
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function discoverWorkspacePackages(repositoryRoot) {
  const packages = [];
  for (const workspaceRoot of workspaceRoots) {
    const rootPath = join(repositoryRoot, workspaceRoot);
    if (!existsSync(rootPath)) {
      continue;
    }
    const children = await readdir(rootPath, { withFileTypes: true });
    for (const child of children) {
      if (!child.isDirectory()) {
        continue;
      }
      const packagePath = join(rootPath, child.name);
      const packageJsonPath = join(packagePath, "package.json");
      if (!existsSync(packageJsonPath)) {
        continue;
      }
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
      packages.push({ name: packageJson.name, path: packagePath, packageJson });
    }
  }
  return packages;
}

function checkDependencies(workspacePackage, entry) {
  const errors = [];
  const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  const declaredDependencies = new Set(
    dependencyFields.flatMap((field) => Object.keys(workspacePackage.packageJson[field] ?? {})),
  );
  for (const dependencyName of declaredDependencies) {
    if (isInternalPackageName(dependencyName) && !entry.dependencies.includes(dependencyName)) {
      errors.push(
        `${workspacePackage.name} declares dependency ${dependencyName} outside its architecture boundary`,
      );
    }
  }
  return errors;
}

function isInternalPackageName(name) {
  return name === "urdira" || name.startsWith("@urdira/");
}

async function checkSourceImports(
  repositoryRoot,
  workspacePackage,
  entry,
  entriesByName,
  workspacePackages,
) {
  const errors = [];
  const sourceFiles = await findSourceFiles(join(workspacePackage.path, "src"));
  const allowedDependencies = new Set([workspacePackage.name, ...entry.dependencies]);
  const declaredDependencies = new Set([
    ...Object.keys(workspacePackage.packageJson.dependencies ?? {}),
    ...Object.keys(workspacePackage.packageJson.devDependencies ?? {}),
    ...Object.keys(workspacePackage.packageJson.optionalDependencies ?? {}),
    ...Object.keys(workspacePackage.packageJson.peerDependencies ?? {}),
  ]);

  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, "utf8");
    for (const specifier of findImportSpecifiers(source)) {
      const sourcePath = relative(repositoryRoot, sourceFile);
      if (specifier.startsWith(".")) {
        const targetPackage = findOwningPackage(
          resolve(dirname(sourceFile), specifier),
          workspacePackages,
        );
        if (targetPackage && targetPackage.name !== workspacePackage.name) {
          if (!allowedDependencies.has(targetPackage.name)) {
            errors.push(
              `${sourcePath} relative import ${specifier} resolves to ${targetPackage.name}, which is not an allowed dependency`,
            );
          } else if (!declaredDependencies.has(targetPackage.name)) {
            errors.push(
              `${sourcePath} relative import ${specifier} resolves to ${targetPackage.name} without declaring the workspace dependency`,
            );
          }
        }
        continue;
      }

      const importName = resolveInternalPackageName(specifier, entriesByName);
      if (!importName) {
        continue;
      }
      if (!entriesByName.has(importName) || !allowedDependencies.has(importName)) {
        errors.push(
          `${sourcePath} imports ${importName}, which is not an allowed dependency`,
        );
      } else if (importName !== workspacePackage.name && !declaredDependencies.has(importName)) {
        errors.push(
          `${sourcePath} imports ${importName} without declaring the workspace dependency`,
        );
      }
    }
  }
  return errors;
}

async function findSourceFiles(directory) {
  if (!existsSync(directory)) {
    return [];
  }
  const files = [];
  const children = await readdir(directory, { withFileTypes: true });
  for (const child of children) {
    const childPath = join(directory, child.name);
    if (child.isDirectory()) {
      files.push(...(await findSourceFiles(childPath)));
    } else if (sourceExtensions.has(extname(child.name))) {
      files.push(childPath);
    }
  }
  return files;
}

function findImportSpecifiers(source) {
  const imports = new Set();
  const importPattern = /(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (specifier) {
      imports.add(specifier);
    }
  }
  return imports;
}

function resolveInternalPackageName(specifier, entriesByName) {
  for (const packageName of entriesByName.keys()) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
      return packageName;
    }
  }
  if (isInternalPackageSpecifier(specifier)) {
    return specifier.startsWith("@urdira/")
      ? specifier.split("/").slice(0, 2).join("/")
      : "urdira";
  }
  return undefined;
}

function isInternalPackageSpecifier(specifier) {
  return specifier === "urdira" || specifier.startsWith("urdira/") || specifier.startsWith("@urdira/");
}

function findOwningPackage(filePath, workspacePackages) {
  return workspacePackages.find((workspacePackage) => {
    const pathWithinPackage = relative(workspacePackage.path, filePath);
    return (
      pathWithinPackage === "" ||
      (!pathWithinPackage.startsWith(`..${sep}`) &&
        pathWithinPackage !== ".." &&
        !isAbsolute(pathWithinPackage))
    );
  });
}

function checkCoverage(coverage, entriesByName) {
  if (coverage === undefined) {
    return [];
  }
  if (!Array.isArray(coverage)) {
    return ["Architecture coverage must be an array"];
  }
  const errors = [];
  const areas = new Set();
  for (const item of coverage) {
    if (!item || typeof item.area !== "string" || typeof item.owner !== "string") {
      errors.push("Architecture coverage contains an invalid area entry");
      continue;
    }
    if (areas.has(item.area)) {
      errors.push(`Architecture coverage contains duplicate area ${item.area}`);
    }
    areas.add(item.area);
    if (!entriesByName.has(item.owner)) {
      errors.push(`Architecture area ${item.area} is owned by missing package ${item.owner}`);
    }
  }
  return errors;
}

async function main() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = await loadArchitectureManifest(repositoryRoot);
  const result = await checkArchitecture(repositoryRoot, manifest);
  if (result.errors.length > 0) {
    console.error(result.errors.map((error) => `Architecture error: ${error}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Architecture checks passed for ${result.checkedPackages.length} workspace packages.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
