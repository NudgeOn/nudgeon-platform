import type { ReactNode } from "react";
import "./journeys.css";

export default function JourneysLayout({ children }: { children: ReactNode }) {
  return <div className="journey-root">{children}</div>;
}
