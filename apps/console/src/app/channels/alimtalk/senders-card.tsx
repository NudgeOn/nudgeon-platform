"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslations } from "next-intl";
import type { AlimtalkSender } from "@nudgeon/api-client";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { serverMessage } from "./alimtalk-labels";

/** 카카오 발신프로필 키는 40자 고정이다. 벤더에 보내기 전에 여기서 걸러 준다. */
const SENDER_KEY_LENGTH = 40;

/**
 * 발신프로필(카카오 채널) 관리 — 앱당 여러 개, 하나가 기본.
 * 저니 알림톡 노드의 발신프로필 select가 이 목록을 쓴다.
 */
export function SendersCard({
  appId,
  senders,
  pending,
  onChanged,
}: {
  appId: string | undefined;
  senders: AlimtalkSender[];
  pending: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations("alimtalk");
  const [senderKey, setSenderKey] = useState("");
  const [channelName, setChannelName] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      if (!appId) throw new Error(t("error.noApp"));
      return api.alimtalk.senders.create(appId, {
        sender_key: senderKey.trim(),
        channel_name: channelName.trim() || undefined,
        is_default: isDefault,
      });
    },
    onSuccess: () => {
      setSenderKey("");
      setChannelName("");
      setIsDefault(false);
      setMsg(t("senders.added"));
      onChanged();
    },
    onError: (e) => setMsg(serverMessage(e, t("senders.addFailed"))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => {
      if (!appId) throw new Error(t("error.noApp"));
      return api.alimtalk.senders.remove(appId, id);
    },
    onSuccess: () => {
      setMsg(t("senders.removed"));
      onChanged();
    },
    onError: (e) => setMsg(serverMessage(e, t("senders.removeFailed"))),
  });

  const keyLength = senderKey.trim().length;
  const keyValid = keyLength === SENDER_KEY_LENGTH;

  return (
    <Card>
      <CardHeader className="p-4">
        <CardTitle className="text-sm">{t("senders.title")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4 pt-0 text-sm">
        {pending ? (
          <p className="text-xs text-muted-foreground">{t("loading")}</p>
        ) : senders.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("senders.empty")}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {senders.map((sender) => (
              <li key={sender.id} className="flex items-center justify-between gap-2 p-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {sender.channel_name || t("senders.noChannelName")}
                    {sender.is_default && <span className="ml-2 text-xs text-primary">{t("senders.default")}</span>}
                    {sender.status === "disabled" && (
                      <span className="ml-2 text-xs text-muted-foreground">{t("senders.disabled")}</span>
                    )}
                  </p>
                  <code className="block truncate text-xs text-muted-foreground" title={sender.sender_key}>
                    {sender.sender_key}
                  </code>
                </div>
                <Button
                  variant="outline"
                  className="h-7 shrink-0 px-2 text-xs"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(sender.id)}
                >
                  {t("senders.remove")}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-2 rounded-md border border-border p-2">
          <p className="text-xs font-medium">{t("senders.addTitle")}</p>
          <div className="flex flex-col gap-1">
            <Label htmlFor="sender-key" className="text-xs">
              {t("senders.keyLabel", { n: SENDER_KEY_LENGTH })}
            </Label>
            <Input
              id="sender-key"
              value={senderKey}
              maxLength={SENDER_KEY_LENGTH}
              placeholder={t("senders.keyPlaceholder")}
              onChange={(e) => setSenderKey(e.target.value)}
            />
            <p className={`text-xs ${keyLength > 0 && !keyValid ? "text-destructive" : "text-muted-foreground"}`}>
              {t("senders.keyCount", { n: keyLength, max: SENDER_KEY_LENGTH })}
              {keyLength > 0 && !keyValid && ` — ${t("senders.keyLengthError", { n: SENDER_KEY_LENGTH })}`}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="sender-name" className="text-xs">
              {t("senders.channelName")}
            </Label>
            <Input
              id="sender-name"
              value={channelName}
              placeholder={t("senders.channelNamePlaceholder")}
              onChange={(e) => setChannelName(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            {t("senders.setDefault")}
          </label>
          <Button
            className="mt-1"
            disabled={!appId || !keyValid || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? t("senders.adding") : t("senders.add")}
          </Button>
        </div>
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
