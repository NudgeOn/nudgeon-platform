import { useState } from 'react';

export default function LaunchQuickstart({ guide, renderCode }) {
  const [selected, setSelected] = useState(null);
  const item = guide.platforms.find(platform => platform.id === selected);
  return <section className="launch-quickstart" aria-label={guide.title}>
    <h3>{guide.title}</h3><p>{guide.intro}</p>
    <div className="launch-platform-buttons">
      {guide.platforms.map(platform => <button key={platform.id} type="button"
        aria-expanded={selected === platform.id} aria-controls="launch-quickstart-panel"
        onClick={() => setSelected(selected === platform.id ? null : platform.id)}>
        <strong>{platform.label}</strong><span>{platform.requirements}</span>
      </button>)}
    </div>
    <div id="launch-quickstart-panel" hidden={!item}>
      {item && <div className="launch-quickstart-panel">
        <h4>{item.label}</h4>
        <p>{guide.prerequisite}</p>
        <ol>
          <li><h5>{guide.download}</h5>{renderCode(`${item.id}-download`, guide.download, guide.clone)}</li>
          <li><h5>{guide.configure}</h5><p>{item.configure}</p><p>{guide.keyNote}</p></li>
          <li><h5>{guide.build}</h5>{renderCode(`${item.id}-build`, guide.build, item.build)}<p>{item.run}</p></li>
          <li><h5>{guide.test}</h5><p>{guide.testBody}</p></li>
        </ol>
        <nav aria-label={item.label}><a href={item.project}>{guide.project} ↗</a><a href={guide.readme}>{guide.readmeLabel} ↗</a></nav>
      </div>}
    </div>
  </section>;
}
