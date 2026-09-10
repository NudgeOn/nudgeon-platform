"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { ApiError, type SignupResponse } from "@nudgeon/api-client";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SignupPage() {
  const t = useTranslations("signup");
  const router = useRouter();
  const [form, setForm] = useState({
    tenant_name: "",
    name: "",
    email: "",
    password: "",
  });
  const [keys, setKeys] = useState<SignupResponse | null>(null);

  const signup = useMutation({
    mutationFn: () => api.auth.signup(form),
    onSuccess: (res) => setKeys(res),
  });

  const errorMessage =
    signup.error instanceof ApiError && signup.error.status === 409
      ? t("errorDuplicate")
      : signup.error
        ? t("errorGeneric")
        : null;

  if (keys) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>{t("doneTitle")}</CardTitle>
            <CardDescription>
              {t("doneDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label>{t("sdkKey")}</Label>
              <code className="break-all rounded-md bg-muted p-3 text-xs">{keys.sdk_key}</code>
            </div>
            <div className="flex flex-col gap-2">
              <Label>{t("serverKey")}</Label>
              <code className="break-all rounded-md bg-muted p-3 text-xs">{keys.server_key}</code>
            </div>
            <Button onClick={() => router.push("/")}>{t("goConsole")}</Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              signup.mutate();
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="tenant_name">{t("tenantName")}</Label>
              <Input
                id="tenant_name"
                required
                value={form.tenant_name}
                onChange={(e) => setForm({ ...form, tenant_name: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">{t("name")}</Label>
              <Input
                id="name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">{t("email")}</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">{t("password")}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </div>
            {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
            <Button type="submit" disabled={signup.isPending}>
              {signup.isPending ? t("creating") : t("submit")}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              {t("haveAccount")}{" "}
              <Link href="/login" className="text-primary underline">
                {t("login")}
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
