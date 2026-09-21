import { Tooltip } from "@heroui/react";
import { Trans } from "@lingui/react/macro";
import type { AgentProviderMetadata } from "@/shared/contracts";
import { useSharedSettings } from "@/renderer/state/sharedSettingsStore";
import { threadAccountDetails, threadAccountName } from "./threadAccount";

/**
 * The account a thread runs on, shown in the thread header just before the
 * project name. The provider icon is identical for every profile of one
 * provider, so without this line two threads on two logins look the same. The
 * name is the profile's ("Work"); the signed-in email, plan, and organization
 * stay in the tooltip — they are longer than the header can hold and are not
 * something to leave on screen during a screen share.
 */
export function ThreadAccountLabel(props: {
  agentKind: string;
  agentLabel?: string | undefined;
  providerMetadata?: AgentProviderMetadata | undefined;
}) {
  const agentInstances = useSharedSettings((s) => s.agentInstances);
  const name = threadAccountName(props.agentKind, agentInstances, props.agentLabel);
  if (!name) return null;

  const details = threadAccountDetails(props.providerMetadata);
  const label = (
    <span className="max-w-[9rem] truncate px-1 text-sm leading-tight text-muted/60 @max-[560px]:max-w-[6rem] @max-[560px]:text-xs @max-[360px]:hidden">
      {name}
    </span>
  );
  if (!details) return label;

  return (
    <Tooltip delay={150}>
      <Tooltip.Trigger className="min-w-0" tabIndex={-1} role="none">
        {label}
      </Tooltip.Trigger>
      <Tooltip.Content placement="bottom" className="max-w-[22rem] break-words text-xs">
        <div className="space-y-0.5 py-0.5">
          <p className="font-semibold text-foreground">{name}</p>
          {details.authenticatedAs ? <p className="text-muted">{details.authenticatedAs}</p> : null}
          {details.plan || details.organization ? (
            <p className="text-muted">
              {[details.plan, details.organization].filter(Boolean).join(" · ")}
            </p>
          ) : null}
          {!details.authenticatedAs ? (
            <p className="text-muted/70">
              <Trans>This provider reports no signed-in account.</Trans>
            </p>
          ) : null}
        </div>
      </Tooltip.Content>
    </Tooltip>
  );
}
