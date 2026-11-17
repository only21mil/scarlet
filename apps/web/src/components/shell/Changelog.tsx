import { CHANGELOG, plainChange, type ChangelogDay } from "../../lib/changelog";
import { Icon } from "../ui/primitives";

/** Show the latest dated group up front and keep the full history available. */
export function Changelog() {
  const [latest, ...earlier] = CHANGELOG;
  if (!latest) return null;

  return <section className="card about-changelog" aria-labelledby="changelog-heading">
    <h2 id="changelog-heading">What’s new</h2>
    <Day {...latest} />
    {earlier.length > 0 && <details className="about-disclosure">
      <summary>Earlier changes<Icon name="chevron" size={12} /></summary>
      {earlier.map(day => <Day key={day.date} {...day} />)}
    </details>}
  </section>;
}

function Day({ date, changes }: ChangelogDay) {
  return <div className="about-release-day">
    <h3>{date}</h3>
    <ul>{changes.map(change => <li key={change}>{plainChange(change)}</li>)}</ul>
  </div>;
}
