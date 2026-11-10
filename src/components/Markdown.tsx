"use client";

import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { hostOf } from "./format";
import type { Source } from "./types";

function safeHref(href?: string): string | undefined {
  if (!href) return undefined;
  return /^https?:\/\//i.test(href) ? href : undefined;
}

const norm = (u: string) => u.replace(/^https?:\/\/(www\.)?/i, "").replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();

/**
 * Raw HTML is never rendered (react-markdown default + skipHtml); links are
 * http(s) only. Links that match a recorded source render as a numbered chip.
 */
export const Markdown = memo(function Markdown({ text, sources = [] }: { text: string; sources?: Source[] }) {
  const components = useMemo<Components>(() => {
    const index = new Map<string, { n: number; s: Source }>();
    sources.forEach((s, i) => index.set(norm(s.url), { n: s.sourceNo ?? i + 1, s }));
    return {
      a: ({ href, children }) => {
        const safe = safeHref(href);
        if (!safe) return <span>{children}</span>;
        const hit = index.get(norm(safe));
        const host = hostOf(safe);
        const unverified = hit?.s.origin === "answer_link";
        return (
          <a
            href={safe}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className={`cite${unverified ? " cite-unverified" : ""}`}
            title={unverified ? `${host} — linked by the model, not returned by search` : host}
          >
            {children}
            {hit && (
              <sup className="cite-no" aria-label={`source ${hit.n}`}>
                {hit.n}
              </sup>
            )}
          </a>
        );
      },
      table: ({ children }) => (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Table">
          <table>{children}</table>
        </div>
      ),
      pre: ({ children }) => (
        <pre tabIndex={0}>{children}</pre>
      ),
    };
  }, [sources]);
  return (
    <div className="prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});
