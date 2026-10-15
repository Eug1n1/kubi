import { useState } from "react";
import { ContextRail } from "./contexts";
import { SettingsModal } from "./settings";
import { useKubi } from "./useKubi";
import { argoInstalled } from "./catalog";
import {
  ArgoScreen,
  CreateModal,
  DeleteModal,
  Detail,
  ForwardBar,
  ForwardDialog,
  PinnedSplash,
  SessionDrawer,
  OverviewScreen,
  ResourceScreen,
  SearchModal,
  Sidebar,
  TopBar,
} from "./screens";

export function App({ pinned = null }: { pinned?: string | null }) {
  const kubi = useKubi({ pinned });
  const [detailWidth, setDetailWidth] = useState(440);
  const [logHeight, setLogHeight] = useState(240);
  const argo = kubi.active == null && kubi.home === "argo" && argoInstalled(kubi.customResources);
  return (
    <div className={pinned == null ? "app" : "app no-rail"}>
      <TopBar kubi={kubi} />
      {/* A context window is pinned to one cluster: there is no rail, the
          window title and the topbar chip say which cluster it is. */}
      {pinned == null ? <ContextRail kubi={kubi} /> : null}
      {kubi.pinnedMissing ? (
        <PinnedSplash kubi={kubi} />
      ) : (
        <>
          <Sidebar kubi={kubi} />
          <main className="main">
            <div className="workspace">
              {kubi.active != null ? <ResourceScreen kubi={kubi} /> : argo ? <ArgoScreen kubi={kubi} /> : <OverviewScreen kubi={kubi} />}
              {kubi.activeTab?.selected ? <Detail kubi={kubi} width={detailWidth} onWidth={setDetailWidth} /> : null}
            </div>
            <ForwardBar kubi={kubi} />
            {kubi.dockTabs.some((tab) => !tab.detached) ? (
              <SessionDrawer kubi={kubi} height={logHeight} onHeight={setLogHeight} />
            ) : null}
          </main>
        </>
      )}
      {kubi.forwardDraft ? <ForwardDialog kubi={kubi} /> : null}
      {kubi.searchOpen ? <SearchModal kubi={kubi} /> : null}
      {kubi.createOpen ? <CreateModal kubi={kubi} /> : null}
      {kubi.pendingDelete ? <DeleteModal kubi={kubi} /> : null}
      {kubi.settingsOpen ? <SettingsModal kubi={kubi} /> : null}
    </div>
  );
}
