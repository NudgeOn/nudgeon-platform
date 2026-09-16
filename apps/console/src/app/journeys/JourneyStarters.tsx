import Link from "next/link";
import { useTranslations } from "next-intl";
import { JourneyIcon } from "./journey-ui";
import { JOURNEY_TEMPLATES } from "./journey-templates";
import "./journey-starters.css";

export function JourneyStarters() {
  const t = useTranslations("journeys.starters");
  return (
    <section className="j-starters" aria-labelledby="starter-title">
      <div className="j-starters-heading">
        <div><h2 id="starter-title">{t("title")}</h2><p>{t("description")}</p></div>
        <span><JourneyIcon name="check" size={14} />{t("draftOnly")}</span>
      </div>
      <div className="j-starters-options">
        {JOURNEY_TEMPLATES.map((template, index) => (
          <Link className="j-starter" key={template} href={`/journeys/new?template=${template}`}>
            <span className="j-starter-number">0{index + 1}</span>
            <h3>{t(`${template}.name`)}</h3>
            <p>{t(`${template}.description`)}</p>
            <span className="j-starter-path">{t(`${template}.path`)}</span>
            <span className="j-starter-action">{t("use")}<JourneyIcon name="arrow-right" size={16} /></span>
          </Link>
        ))}
      </div>
    </section>
  );
}
