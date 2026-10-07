"use client";

import { useId, useRef, useState, type ComponentProps } from "react";
import { Check, Search } from "lucide-react";
import { categoryGroups, categories, type Category } from "@/lib/categories";
import { cn } from "@/lib/utils";
import { CategoryOptions } from "@/components/category-options";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useNativeSelectBoundary } from "@/components/ui/use-native-select-boundary";
import { normalizeSearch } from "@/lib/transaction-tools";

type CategorySelectProps = Pick<ComponentProps<"select">,
  "id" | "name" | "disabled" | "onBlur" | "aria-describedby" | "aria-invalid"
> & {
  label: string;
  className?: string;
  excludeReview?: boolean;
} & ({
  allowAll: true;
  allLabel?: string;
  value: Category | "";
  onValueChange: (value: Category | "") => void;
} | {
  allowAll?: false;
  allLabel?: never;
  value: Category;
  onValueChange: (value: Category) => void;
});

export function CategorySelect(props: CategorySelectProps) {
  useNativeSelectBoundary();
  const { label, className, excludeReview, disabled, value, id, name, onBlur } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const searchLabel = props.allowAll ? "Kategorien durchsuchen" : `${label} durchsuchen`;
  const groups = categoryGroups.map((group) => ({
    ...group,
    categories: group.categories.filter((category) =>
      (!excludeReview || category !== "Prüfen") &&
      normalizeSearch(`${group.label} ${category}`).includes(normalizeSearch(query)),
    ),
  })).filter((group) => group.categories.length);
  const showAll = props.allowAll && normalizeSearch(props.allLabel ?? "Alle Kategorien").includes(normalizeSearch(query));
  const options: (Category | "")[] = [
    ...(showAll ? [""] as const : []),
    ...groups.flatMap((group) => group.categories),
  ];

  function choose(category: Category | "") {
    if (category === "") {
      if (props.allowAll) props.onValueChange(category);
    } else {
      props.onValueChange(category);
    }
    setOpen(false);
  }

  function move(index: number) {
    setActive(index);
    list.current?.querySelectorAll<HTMLElement>('[role="option"]')[index]
      ?.scrollIntoView({ block: "nearest" });
  }

  function option(category: Category | "") {
    const index = options.indexOf(category);
    return (
      <button
        id={`${listId}-${index}`}
        key={category}
        type="button"
        role="option"
        aria-selected={value === category}
        tabIndex={-1}
        className={cn(
          "flex min-h-10 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
          index === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
        )}
        onMouseMove={() => setActive(index)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(category)}
      >
        <Check aria-hidden="true" className={cn("size-4 shrink-0 text-primary", value !== category && "invisible")} />
        {category || props.allLabel || "Alle Kategorien"}
      </button>
    );
  }

  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      <select
        id={id}
        name={name}
        aria-label={label}
        aria-describedby={props["aria-describedby"]}
        aria-invalid={props["aria-invalid"]}
        className="select-input min-w-0 flex-1"
        value={value}
        disabled={disabled}
        onBlur={onBlur}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "" && props.allowAll) props.onValueChange("");
          else {
            const category = categories.find((item) => item === next);
            if (category) props.onValueChange(category);
          }
        }}
      >
        {props.allowAll && <option value="">{props.allLabel ?? "Alle Kategorien"}</option>}
        {excludeReview && <option value="Prüfen" disabled>Kategorie wählen</option>}
        <CategoryOptions excludeReview={excludeReview} />
      </select>
      <Popover open={open} onOpenChange={(next) => {
        setOpen(next);
        if (next) { setQuery(""); setActive(0); }
      }}>
        <PopoverTrigger asChild>
          <Button type="button" size="icon" variant="ghost" disabled={disabled}
            aria-label={searchLabel} title="Kategorien durchsuchen">
            <Search className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent aria-label="Kategoriesuche" className="flex flex-col overflow-hidden p-2">
          <div className="shrink-0 p-1">
            <Input
              role="combobox"
              aria-label="Kategorien suchen"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={options.length ? `${listId}-${active}` : undefined}
              placeholder="Kategorie oder Gruppe suchen …"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setActive(0); }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (options.length) move((active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const category = options[active];
                  if (category !== undefined) choose(category);
                }
              }}
            />
          </div>
          <div ref={list} id={listId} role="listbox" aria-label="Kategorien"
            className="min-h-0 max-h-72 overflow-y-auto overscroll-contain">
            {showAll && option("")}
            {groups.map((group) => (
              <div key={group.label} role="group" aria-label={group.label} className="border-t first:border-t-0">
                <p className="px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">{group.label}</p>
                {group.categories.map(option)}
              </div>
            ))}
          </div>
          {!options.length && <p role="status" className="px-3 py-6 text-sm text-muted-foreground">Keine passende Kategorie.</p>}
        </PopoverContent>
      </Popover>
    </div>
  );
}
