import type { ComponentType } from "react";
import ConnectingContracts from "./ConnectingContracts";
import ContractGuard from "./ContractGuard";
import GettingStarted from "./GettingStarted";
import Introduction from "./Introduction";
import RelayerSdk from "./RelayerSdk";
import SecurityModel from "./SecurityModel";
import SecurityPolicies from "./SecurityPolicies";
import StatusPages from "./StatusPages";
import WatcherGuardian from "./WatcherGuardian";

/** Page content by docs slug. Keys must match lib/docs-index.ts (checked by a test). */
export const DOC_CONTENT: Record<string, ComponentType> = {
  "": Introduction,
  "getting-started": GettingStarted,
  "connecting-contracts": ConnectingContracts,
  "security-policies": SecurityPolicies,
  "contract-guard": ContractGuard,
  "relayer-sdk": RelayerSdk,
  "watcher-and-guardian": WatcherGuardian,
  "status-pages": StatusPages,
  "security-model": SecurityModel,
};
