import React, { useId, useMemo, useRef, useState } from "react";
import { filterChoices, type ChoiceLike } from "./presentation.js";

export function SearchableSelect({
  choices,
  value,
  label,
  placeholder,
  loading = false,
  disabled = false,
  onChange,
}: {
  choices: readonly ChoiceLike[];
  value: string;
  label: string;
  placeholder: string;
  loading?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const selected = choices.find((choice) => choice.value === value);
  const filtered = useMemo(() => filterChoices(choices, query, 80), [choices, query]);

  const choose = (choice: ChoiceLike): void => {
    onChange(choice.value);
    setQuery("");
    setOpen(false);
    setActiveIndex(0);
    input.current?.focus();
  };

  const shownValue = open ? query : selected?.label ?? "";
  const unavailable = disabled || loading;

  return <div className={`searchable-field ${open ? "open" : ""}`} ref={root}>
    <span className="field-label">{label}</span>
    <div className="combobox-control">
      <input
        ref={input}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={`${id}-choices`}
        aria-autocomplete="list"
        aria-activedescendant={open && filtered[activeIndex] ? `${id}-choice-${activeIndex}` : undefined}
        autoComplete="off"
        disabled={unavailable}
        value={shownValue}
        placeholder={loading ? `Loading ${label.toLocaleLowerCase()}…` : placeholder}
        onFocus={() => { setOpen(true); setQuery(""); setActiveIndex(0); }}
        onBlur={(event) => {
          if (root.current?.contains(event.relatedTarget as Node | null)) return;
          setOpen(false); setQuery(""); setActiveIndex(0);
        }}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); setActiveIndex(0); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActiveIndex((current) => Math.min(current + 1, Math.max(0, filtered.length - 1))); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((current) => Math.max(0, current - 1)); }
          else if (event.key === "Enter" && open && filtered[activeIndex]) { event.preventDefault(); choose(filtered[activeIndex]); }
          else if (event.key === "Escape") { setOpen(false); setQuery(""); }
        }}
      />
      {loading ? <span className="combobox-spinner spinner"/> : value && !disabled ? <button type="button" className="combobox-clear" aria-label={`Clear ${label.toLocaleLowerCase()}`} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(""); setQuery(""); setOpen(true); }}>×</button> : <span className="combobox-chevron" aria-hidden="true">⌄</span>}
    </div>
    {open && !unavailable && <div className="combobox-popover" id={`${id}-choices`} role="listbox" aria-label={`${label} choices`}>
      <div className="combobox-summary">{filtered.length === 0 ? "No matches" : `${filtered.length}${choices.length > filtered.length ? ` of ${choices.length}` : ""} choices`}</div>
      {filtered.map((choice, index) => <button
        type="button"
        id={`${id}-choice-${index}`}
        role="option"
        aria-selected={choice.value === value}
        className={index === activeIndex ? "active" : ""}
        key={choice.value}
        onMouseEnter={() => setActiveIndex(index)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(choice)}
      ><span>{choice.label}</span>{choice.value === value && <b>Selected</b>}</button>)}
      {filtered.length === 0 && <p>Try a file name, folder, or symbol kind.</p>}
    </div>}
  </div>;
}
