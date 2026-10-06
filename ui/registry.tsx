import { createContext, useContext } from 'react';
import { defineRegistry, JSONUIProvider, Renderer } from '@json-render/react';
import type { Spec } from '@json-render/core';
import { catalog } from '../src/catalog';
import { absoluteFor } from './base-path';

export const Navigation = createContext<(href: string) => void>(href => window.location.assign(href));
const { registry } = defineRegistry(catalog, {
  components: {
    Surface: ({ props, children }) => <article className={`surface layout-${props.layout} palette-${props.palette}`}>{children}</article>,
    Header: ({ props }) => <header className="site-header"><div className="eyebrow">{props.brand}</div><h1>{props.title}</h1><p className="lede">{props.subtitle}</p></header>,
    Section: ({ props }) => <section className="section"><h2>{props.heading}</h2>{props.kind === 'code'
      ? <pre><code>{props.body}</code></pre> : props.kind === 'quote'
        ? <blockquote>{props.body}</blockquote> : <p>{props.body}</p>}</section>,
    Placeholder: ({ props }) => <figure className="placeholder" role="img" aria-label={props.alt}><span>SIMULATED IMAGE</span><figcaption>{props.alt}</figcaption></figure>,
    Links: ({ props, children }) => <nav className="link-group" aria-label={props.title}><h2>{props.title}</h2>{children}</nav>,
    Link: ({ props }) => {
      const navigate = useContext(Navigation);
      const safe = props.href.startsWith('/view?') || props.href.startsWith('/search?');
      if (!safe) return <span>{props.label}</span>;
      return <a className="world-link" href={absoluteFor(props.href)} onClick={e => {
        if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
          e.preventDefault(); navigate(props.href);
        }
      }}><strong>{props.label}<span aria-hidden="true"> ↗</span></strong><small>{props.detail}</small></a>;
    },
  },
});
export function WorldView({ spec }: { spec: Spec }) {
  return <JSONUIProvider registry={registry}><Renderer spec={spec} registry={registry} /></JSONUIProvider>;
}
