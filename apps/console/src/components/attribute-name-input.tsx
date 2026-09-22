"use client";

import type { InputHTMLAttributes } from "react";
import { useTranslations } from "next-intl";
import { STANDARD_ATTRIBUTES } from "@nudgeon/api-client";
import { Input } from "./ui/input";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
};

/** Presets write the same canonical value as typing; custom names remain editable. */
export function AttributeNameInput({ value, onValueChange, ...props }: Props) {
  const t = useTranslations("attributeCatalog");
  const known = STANDARD_ATTRIBUTES.some((event) => event.key === value);
  return <span className="flex min-w-0 flex-col gap-2">
    <select aria-label={t("choose")} disabled={props.disabled} value={known ? value : ""}
      className="h-9 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs"
      onChange={(event) => { if (event.currentTarget.value) onValueChange(event.currentTarget.value); }}>
      <option value="">{t("choose")}</option>
      {STANDARD_ATTRIBUTES.map((event) => <option key={event.key} value={event.key}>
        {t(`attributes.${event.key}.label`)} · {event.key}
      </option>)}
    </select>
    <Input {...props} value={value} aria-label={props["aria-label"] ?? t("name")}
      maxLength={128} autoComplete="off" spellCheck={false}
      onChange={(event) => onValueChange(event.currentTarget.value)} />
  </span>;
}
