import { useState } from "react";
import { ContextRail } from "./contexts";
import { useKubi } from "./useKubi";
import { argoInstalled } from "./catalog";
import {
  ArgoScreen,
  CreateModal,
  DeleteModal,
  Detail,
  ForwardBar,
  ForwardDialog,
  SessionDrawer,
  OverviewScreen,
  ResourceScreen,
  SearchModal,
  Sidebar,
  TopBar,
} from "./screens";

export function App() {
  const kubi = useKubi();
  const [detailWidth, setDetailWidth] = useState(440);
  const [logHeight, setLogHeight] = useState(240);
  const argo = kubi.active == null && kubi.home === "argo" && argoInstalled(kubi.customResources);
  return (
    <div className="app">
      <TopBar kubi={kubi} />
      <ContextRail kubi={kubi} />
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
      {kubi.forwardDraft ? <ForwardDialog kubi={kubi} /> : null}
      {kubi.searchOpen ? <SearchModal kubi={kubi} /> : null}
      {kubi.createOpen ? <CreateModal kubi={kubi} /> : null}
      {kubi.pendingDelete ? <DeleteModal kubi={kubi} /> : null}
    </div>
  );
}
