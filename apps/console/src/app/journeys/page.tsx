"use client";

import { useQuery } from "@tanstack/react-query";
import { ApiError, type JourneySummary } from "@nudgeon/api-client";
import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { JourneyIcon, JourneyStatus, JourneyTopbar } from "./journey-ui";
import "./journey-list.css";

type StatusFilter = "all" | JourneySummary["status"];

const STATUS_FILTERS: StatusFilter[] = ["all", "draft", "active", "paused", "archived"];

// 목록 시각은 KST 고정(헤더에 KST 표기) — 숫자 형식만 로케일을 따른다.
function formatUpdatedAt(value: string, locale: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Seoul",
  }).format(date);
}

export default function JourneysPage() {
  const t = useTranslations("journeys");
  const locale = useLocale();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api.apps.list() });
  const appId = apps.data?.apps[0]?.id;
  const journeys = useQuery({
    queryKey: ["journeys", appId],
    queryFn: () => api.journeys.list(appId!),
    enabled: !!appId,
  });

  // Counts describe successful API data only. A failed request is never an empty list.
  const hasResults = apps.isSuccess && !!appId && journeys.isSuccess;
  const items = hasResults ? journeys.data.journeys : [];
  const normalizedSearch = search.trim().toLocaleLowerCase(locale);
  const filtered = items.filter(
    (journey) =>
      (status === "all" || journey.status === status) &&
      journey.name.toLocaleLowerCase(locale).includes(normalizedSearch),
  );
  const counts = hasResults
    ? items.reduce(
        (result, journey) => {
          result.all += 1;
          result[journey.status] += 1;
          return result;
        },
        { all: 0, draft: 0, active: 0, paused: 0, archived: 0 },
      )
    : null;
  const appError = apps.isError;
  const journeyError = !!appId && journeys.isError;
  const authenticationRequired =
    (appError && apps.error instanceof ApiError && apps.error.status === 401) ||
    (journeyError && journeys.error instanceof ApiError && journeys.error.status === 401);
  const missingApp = apps.isSuccess && !appId;
  const loading = apps.isPending || (!!appId && journeys.isPending);
  const canCreate = apps.isSuccess && !!appId && !authenticationRequired;

  function resetFilters() {
    setSearch("");
    setStatus("all");
  }

  return (
    <>
      <JourneyTopbar
        actions={
          <Link className="j-button" href="/">
            <JourneyIcon name="arrow-left" size={16} />{t("dashboard")}
          </Link>
        }
      />
      <main className="j-list-page">
        <header className="j-list-heading">
          <div>
            <h1>{t("title")}</h1>
            <p>{t("subtitle")}</p>
          </div>
          {canCreate ? (
            <Link className="j-button j-button-primary" href="/journeys/new">
              <JourneyIcon name="plus" size={18} />{t("new")}
            </Link>
          ) : (
            <button className="j-button j-button-primary" type="button" disabled>
              <JourneyIcon name="plus" size={18} />{t("new")}
            </button>
          )}
        </header>

        <section aria-label={t("listLabel")}>
          <div className="j-list-toolbar">
            <div className="j-list-filters" role="group" aria-label={t("statusFilterLabel")}>
              {STATUS_FILTERS.map((filter) => (
                <button
                  key={filter}
                  className={`j-list-filter${status === filter ? " is-selected" : ""}`}
                  type="button"
                  aria-pressed={status === filter}
                  disabled={!hasResults}
                  onClick={() => setStatus(filter)}
                >
                  {t(`filter.${filter}`)}
                  {counts && (
                    <span className="j-list-filter-count">
                      {counts[filter].toLocaleString(locale)}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="j-list-search">
              <JourneyIcon name="search" size={17} />
              <input
                type="search"
                aria-label={t("searchPlaceholder")}
                placeholder={t("searchPlaceholder")}
                value={search}
                disabled={!hasResults}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search && (
                <button type="button" aria-label={t("clearSearch")} onClick={() => setSearch("")}>
                  <JourneyIcon name="close" size={14} />
                </button>
              )}
            </div>
          </div>

          {appError || journeyError ? (
            <div className="j-list-state j-list-state-error" role="alert">
              <span className="j-list-state-icon"><JourneyIcon name="info" size={26} /></span>
              <h2>
                {authenticationRequired ? t("error.loginTitle")
                  : appError ? t("error.appTitle") : t("error.listTitle")}
              </h2>
              <p>
                {authenticationRequired ? t("error.loginBody") : t("error.retryBody")}
              </p>
              {authenticationRequired ? (
                <Link className="j-button j-button-primary" href="/login">
                  {t("error.login")} <JourneyIcon name="arrow-right" size={16} />
                </Link>
              ) : (
                <button
                  className="j-button"
                  type="button"
                  disabled={appError ? apps.isFetching : journeys.isFetching}
                  onClick={() => void (appError ? apps.refetch() : journeys.refetch())}
                >{t("error.retry")}</button>
              )}
            </div>
          ) : missingApp ? (
            <div className="j-list-state">
              <span className="j-list-state-icon"><JourneyIcon name="trigger" size={28} /></span>
              <h2>{t("noApp.title")}</h2>
              <p>{t("noApp.body")}</p>
              <Link href="/onboarding" className="j-button j-button-primary">
                {t("noApp.cta")} <JourneyIcon name="arrow-right" size={16} />
              </Link>
            </div>
          ) : loading ? (
            <div className="j-list-state j-list-loading" role="status" aria-live="polite">
              <span className="j-list-loader" aria-hidden="true" />
              <p>{t("loading")}</p>
            </div>
          ) : hasResults && items.length === 0 ? (
            <div className="j-list-state">
              <span className="j-list-state-icon"><JourneyIcon name="trigger" size={28} /></span>
              <h2>{t("empty.title")}</h2>
              <p>{t("empty.body")}</p>
              <Link href="/journeys/new" className="j-button j-button-primary">
                <JourneyIcon name="plus" size={16} />{t("empty.cta")}
              </Link>
            </div>
          ) : hasResults && filtered.length === 0 ? (
            <div className="j-list-state" role="status">
              <span className="j-list-state-icon"><JourneyIcon name="search" size={26} /></span>
              <h2>{t("noMatch.title")}</h2>
              <p>{t("noMatch.body")}</p>
              <button type="button" className="j-button" onClick={resetFilters}>{t("noMatch.reset")}</button>
            </div>
          ) : hasResults ? (
            <div className="j-list-table">
              <div className="j-list-table-head" aria-hidden="true">
                <span>{t("col.journey")}</span><span>{t("col.status")}</span>
                <span>{t("col.updated")} <span className="j-list-timezone">KST</span></span>
                <span />
              </div>
              <ul className="j-list-rows">
                {filtered.map((journey) => <JourneyRow key={journey.id} journey={journey} />)}
              </ul>
            </div>
          ) : null}

          {hasResults && (
            <p className="j-list-footnote" role="status" aria-live="polite">
              <span>
                {status !== "all" || normalizedSearch
                  ? t("footer.filtered", { shown: filtered.length, total: items.length })
                  : t("footer.total", { total: items.length })}
              </span>
              <span>{t("footer.sort")}</span>
            </p>
          )}
        </section>
      </main>
    </>
  );
}

function JourneyRow({ journey }: { journey: JourneySummary }) {
  const t = useTranslations("journeys");
  const locale = useLocale();
  const updatedAt = formatUpdatedAt(journey.updated_at, locale);
  return (
    <li>
      <Link className="j-list-row" href={`/journeys/${journey.id}`}>
        <div className="j-list-identity">
          <span className="j-list-flow-icon"><JourneyIcon name="trigger" size={23} /></span>
          <div className="j-list-name-block">
            <span className="j-list-name" title={journey.name}>{journey.name}</span>
            <span className="j-list-meta">
              <span>{journey.category === "transactional" ? t("category.transactional") : t("category.marketing")}</span>
              {journey.active_version !== null && (
                <>
                  <span className="j-list-meta-dot" aria-hidden="true" />
                  <span>v{journey.active_version}</span>
                </>
              )}
            </span>
          </div>
        </div>
        <div className="j-list-row-status"><JourneyStatus status={journey.status} /></div>
        <div className="j-list-updated">
          <span className="j-list-mobile-date-label">{t("row.updated")} </span>
          {updatedAt ? (
            <time dateTime={journey.updated_at} title={t("row.kst", { time: updatedAt })}>{updatedAt}</time>
          ) : <span>{t("row.unknownTime")}</span>}
        </div>
        <span className="j-list-row-arrow"><JourneyIcon name="arrow-right" size={18} /></span>
      </Link>
    </li>
  );
}
