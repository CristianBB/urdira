import { Base as AliasedBase } from "./base.js";
import { Derived } from "./derived.js";

const instance = new AliasedBase("hello");
const derived = new Derived("world");
export const label = AliasedBase.name + derived.greet() + instance.id;
