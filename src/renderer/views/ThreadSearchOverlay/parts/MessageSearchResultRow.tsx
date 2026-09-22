import { useLingui } from "@lingui/react/macro";
import { handleKeyActivate } from "@/renderer/utils/a11y";
import type { ThreadMessageSearchHit } from "@/shared/contracts";
import { splitSnippet } from "./useMessageSearch";

export function MessageSearchResultRow(props: {
  hit: ThreadMessageSearchHit;
  isSelected: boolean;
  onActivate: () => void;
  onHover: () => void;
}) {
  const { hit, isSelected, onActivate, onHover } = props;
  const { t } = useLingui();
  const who = hit.role === "user" ? t`You` : t`Agent`;
  const stateClass = isSelected
    ? "bg-[var(--row-active)] text-foreground"
    : "text-foreground/85 hover:bg-[var(--row-hover)] hover:text-foreground";

  return (
    <div
      role="option"
      aria-selected={isSelected}
      tabIndex={-1}
      className={`flex w-full cursor-default flex-col gap-0.5 rounded-xl px-3 py-1.5 text-[13px] outline-none transition-colors ${stateClass}`}
      onClick={onActivate}
      onMouseMove={onHover}
      onKeyDown={(e) => handleKeyActivate(e, onActivate)}
    >
      <span className="min-w-0 truncate">{hit.threadTitle}</span>
      <span className="line-clamp-2 text-xs text-muted/90">
        <span className="mr-1 uppercase">{who}</span>
        {splitSnippet(hit.snippet).map((part, index) =>
          part.match ? (
            <mark key={index} className="bg-warning-200 text-foreground">
              {part.text}
            </mark>
          ) : (
            <span key={index}>{part.text}</span>
          ),
        )}
      </span>
    </div>
  );
}
