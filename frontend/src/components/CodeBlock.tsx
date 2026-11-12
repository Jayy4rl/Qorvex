import { useState } from "react";

export function CodeBlock({ code, label, copy = true }: { code: string; label?: string; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable (e.g. insecure origin): the text stays selectable */
    }
  };
  return (
    <figure className="code">
      {(label || copy) && (
        <figcaption className="code-head">
          <span>{label}</span>
          {copy && (
            <button type="button" className="copy-btn" onClick={onCopy} aria-label={label ? `Copy ${label}` : "Copy code"}>
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </figcaption>
      )}
      <pre tabIndex={0}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}
