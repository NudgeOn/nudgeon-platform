"use client";

import { useQuery } from "@tanstack/react-query";
import { ApiError, type JourneySummary } from "@onda/api-client";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { JourneyIcon, JourneyStatus, JourneyTopbar } from "./journey-ui";
import "./journey-list.css";

type StatusFilter = "all" | JourneySummary["status"];

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "draft", label: "초안" },
  { value: "active", label: "활성" },
  { value: "paused", label: "일시정지" },
  { value: "archived", label: "보관" },
];

const updatedAtFormat = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Seoul",
});

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : updatedAtFormat.format(date);
}

export default function JourneysPage() {
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
  const normalizedSearch = search.trim().toLocaleLowerCase("ko-KR");
  const filtered = items.filter(
    (journey) =>
      (status === "all" || journey.status === status) &&
      journey.name.toLocaleLowerCase("ko-KR").includes(normalizedSearch),
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
            <JourneyIcon name="arrow-left" size={16} />대시보드
          </Link>
        }
      />
      <main className="j-list-page">
        <header className="j-list-heading">
          <div>
            <h1>캠페인 · 저니</h1>
            <p>고객에게 닿는 순간을 연결하고, 메시지의 흐름을 설계하세요.</p>
          </div>
          {canCreate ? (
            <Link className="j-button j-button-primary" href="/journeys/new">
              <JourneyIcon name="plus" size={18} />새 저니
            </Link>
          ) : (
            <button className="j-button j-button-primary" type="button" disabled>
              <JourneyIcon name="plus" size={18} />새 저니
            </button>
          )}
        </header>

        <section aria-label="저니 목록">
          <div className="j-list-toolbar">
            <div className="j-list-filters" role="group" aria-label="저니 상태 필터">
              {STATUS_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  className={`j-list-filter${status === filter.value ? " is-selected" : ""}`}
                  type="button"
                  aria-pressed={status === filter.value}
                  disabled={!hasResults}
                  onClick={() => setStatus(filter.value)}
                >
                  {filter.label}
                  {counts && (
                    <span className="j-list-filter-count">
                      {counts[filter.value].toLocaleString("ko-KR")}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="j-list-search">
              <JourneyIcon name="search" size={17} />
              <input
                type="search"
                aria-label="저니 이름 검색"
                placeholder="저니 이름 검색"
                value={search}
                disabled={!hasResults}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search && (
                <button type="button" aria-label="검색어 지우기" onClick={() => setSearch("")}>
                  <JourneyIcon name="close" size={14} />
                </button>
              )}
            </div>
          </div>

          {appError || journeyError ? (
            <div className="j-list-state j-list-state-error" role="alert">
              <span className="j-list-state-icon"><JourneyIcon name="info" size={26} /></span>
              <h2>
                {authenticationRequired ? "로그인이 필요합니다"
                  : appError ? "앱 정보를 불러오지 못했어요" : "저니 목록을 불러오지 못했어요"}
              </h2>
              <p>
                {authenticationRequired ? "로그인한 뒤 저니 목록을 다시 확인해 주세요."
                  : "연결 상태를 확인한 뒤 다시 시도해 주세요."}
              </p>
              {authenticationRequired ? (
                <Link className="j-button j-button-primary" href="/login">
                  로그인하기 <JourneyIcon name="arrow-right" size={16} />
                </Link>
              ) : (
                <button
                  className="j-button"
                  type="button"
                  disabled={appError ? apps.isFetching : journeys.isFetching}
                  onClick={() => void (appError ? apps.refetch() : journeys.refetch())}
                >다시 불러오기</button>
              )}
            </div>
          ) : missingApp ? (
            <div className="j-list-state">
              <span className="j-list-state-icon"><JourneyIcon name="trigger" size={28} /></span>
              <h2>먼저 앱을 설정해 주세요</h2>
              <p>앱 설정을 마치면 고객의 흐름을 만들 수 있어요.</p>
              <Link href="/onboarding" className="j-button j-button-primary">
                앱 설정하기 <JourneyIcon name="arrow-right" size={16} />
              </Link>
            </div>
          ) : loading ? (
            <div className="j-list-state j-list-loading" role="status" aria-live="polite">
              <span className="j-list-loader" aria-hidden="true" />
              <p>저니 목록을 불러오고 있어요.</p>
            </div>
          ) : hasResults && items.length === 0 ? (
            <div className="j-list-state">
              <span className="j-list-state-icon"><JourneyIcon name="trigger" size={28} /></span>
              <h2>첫 번째 저니를 만들어 보세요</h2>
              <p>진입 조건부터 메시지까지, 고객에게 필요한 순간을 연결해 보세요.</p>
              <Link href="/journeys/new" className="j-button j-button-primary">
                <JourneyIcon name="plus" size={16} />새 저니 만들기
              </Link>
            </div>
          ) : hasResults && filtered.length === 0 ? (
            <div className="j-list-state" role="status">
              <span className="j-list-state-icon"><JourneyIcon name="search" size={26} /></span>
              <h2>조건에 맞는 저니가 없어요</h2>
              <p>다른 이름으로 검색하거나 상태 필터를 바꿔 보세요.</p>
              <button type="button" className="j-button" onClick={resetFilters}>필터 초기화</button>
            </div>
          ) : hasResults ? (
            <div className="j-list-table">
              <div className="j-list-table-head" aria-hidden="true">
                <span>저니</span><span>상태</span>
                <span>최근 수정 <span className="j-list-timezone">KST</span></span>
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
                  ? `${filtered.length.toLocaleString("ko-KR")}개 표시 · 전체 ${items.length.toLocaleString("ko-KR")}개`
                  : `총 ${items.length.toLocaleString("ko-KR")}개의 저니`}
              </span>
              <span>최근 수정순</span>
            </p>
          )}
        </section>
      </main>
    </>
  );
}

function JourneyRow({ journey }: { journey: JourneySummary }) {
  const updatedAt = formatUpdatedAt(journey.updated_at);
  return (
    <li>
      <Link className="j-list-row" href={`/journeys/${journey.id}`}>
        <div className="j-list-identity">
          <span className="j-list-flow-icon"><JourneyIcon name="trigger" size={23} /></span>
          <div className="j-list-name-block">
            <span className="j-list-name" title={journey.name}>{journey.name}</span>
            <span className="j-list-meta">
              <span>{journey.category === "transactional" ? "거래성" : "마케팅"}</span>
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
          <span className="j-list-mobile-date-label">수정 </span>
          {updatedAt ? (
            <time dateTime={journey.updated_at} title={`${updatedAt} (한국 시간)`}>{updatedAt}</time>
          ) : <span>시간 확인 필요</span>}
        </div>
        <span className="j-list-row-arrow"><JourneyIcon name="arrow-right" size={18} /></span>
      </Link>
    </li>
  );
}
