import { useEffect, useMemo, type ReactNode } from "react";
import { useApiClient } from "../auth/admin-session";
import { Context } from "../realtime/hooks";
import { realtimeFixture } from "./realtime-fixture";
import { realtimeResourcePath } from "./realtime-resource-path";

export function RealtimeTestProvider({ children }: { children: ReactNode }) {
  const api = useApiClient();
  const { client } = useMemo(
    () =>
      realtimeFixture((resource, params) =>
        api.get(realtimeResourcePath(resource, params)),
      ),
    [api],
  );
  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);
  return <Context.Provider value={client}>{children}</Context.Provider>;
}
