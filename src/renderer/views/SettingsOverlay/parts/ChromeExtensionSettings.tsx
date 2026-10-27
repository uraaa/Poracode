import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { isRemoteSession, readBridge } from "@/renderer/bridge";
import { Button } from "@/renderer/components/common";
import type { ChromeExtensionStatus } from "@/shared/ipc";

export function ChromeExtensionSettings() {
  const { t } = useLingui();
  const remote = isRemoteSession();
  const [status, setStatus] = useState<ChromeExtensionStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [folderFailed, setFolderFailed] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);

  useEffect(() => {
    if (remote) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function refresh() {
      try {
        const next = await readBridge().browserGetChromeExtensionStatus();
        if (!cancelled) {
          setStatus(next);
          setStatusFailed(false);
        }
      } catch {
        if (!cancelled) {
          setStatus(null);
          setStatusFailed(true);
        }
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), 4_000);
      }
    }

    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [remote]);

  async function openFolder() {
    setOpeningFolder(true);
    setFolderFailed(false);
    try {
      await readBridge().browserOpenChromeExtensionFolder();
    } catch {
      setFolderFailed(true);
    } finally {
      setOpeningFolder(false);
    }
  }

  if (remote) return null;

  return (
    <section className="space-y-3" aria-labelledby="chrome-extension-heading">
      <div className="flex items-center justify-between gap-4">
        <h2 id="chrome-extension-heading" className="text-sm font-medium text-foreground">
          <Trans>Chrome extension</Trans>
        </h2>
        {!statusFailed && (
          <span role="status" className="text-xs text-muted">
            {status
              ? status.connected
                ? t`Connected`
                : t`Not connected`
              : t`Checking connection...`}
          </span>
        )}
      </div>
      <p className="text-xs text-muted">
        <Trans>Connect agents to your existing Chrome tabs and signed-in sessions.</Trans>
      </p>
      {status?.extensionPath && (
        <>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-muted">
            <li>
              <Trans>
                Open <code>chrome://extensions</code> in the signed-in Chrome profile you want
                agents to use.
              </Trans>
            </li>
            <li>
              <Trans>Enable Developer mode.</Trans>
            </li>
            <li>
              <Trans>Click Load unpacked and select the extension folder shown below.</Trans>
            </li>
          </ol>
          <code className="block select-text break-all text-xs text-foreground">
            {status.extensionPath}
          </code>
        </>
      )}
      {status && !status.extensionPath && (
        <p className="text-xs text-muted">
          <Trans>
            Chrome extension files are unavailable. Reinstall or update Poracode to restore them.
          </Trans>
        </p>
      )}
      {statusFailed && (
        <p role="alert" className="text-xs text-danger">
          <Trans>Unable to check Chrome extension status.</Trans>
        </p>
      )}
      {folderFailed && (
        <p role="alert" className="text-xs text-danger">
          <Trans>Unable to open the Chrome extension folder.</Trans>
        </p>
      )}
      <Button
        size="sm"
        variant="tertiary"
        isDisabled={!status?.extensionPath}
        isPending={openingFolder}
        onPress={() => void openFolder()}
      >
        <Trans>Open extension folder</Trans>
      </Button>
    </section>
  );
}
