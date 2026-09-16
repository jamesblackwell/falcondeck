import { create } from "zustand";
import {
  operationalConditionContentKey,
  operationalConditionDismissalKey,
  type OperationalCondition,
} from "@falcondeck/client-core";

import { getJson, setJson } from "@/storage/mmkv";

const STORAGE_KEY = "mobile.dismissed-operational-notices";
const MAX_DISMISSALS = 200;
const stored = getJson<unknown>(STORAGE_KEY);
const persisted = Array.isArray(stored)
  ? stored
      .filter((key): key is string => typeof key === "string")
      .slice(-MAX_DISMISSALS)
  : [];

type OperationalNoticeState = {
  dismissed: ReadonlySet<string>;
  dismiss: (condition: OperationalCondition, explicit?: boolean) => void;
};

// Device preferences, not daemon state. Automatic expiry only hides this
// version; an explicit dismissal also survives remounts and daemon restarts.
export const useOperationalNoticeStore = create<OperationalNoticeState>(
  (set, get) => ({
    dismissed: new Set(persisted),
    dismiss: (condition, explicit = false) => {
      const next = new Set(get().dismissed);
      next.add(operationalConditionDismissalKey(condition));
      if (explicit) {
        const key = operationalConditionContentKey(condition);
        next.delete(key);
        next.add(key);
        setJson(
          STORAGE_KEY,
          [...next]
            .filter((entry) => entry.startsWith("content:"))
            .slice(-MAX_DISMISSALS),
        );
      }
      set({ dismissed: new Set([...next].slice(-1000)) });
    },
  }),
);
