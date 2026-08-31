import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { getFeatureFlags, type FeatureFlags } from "../api/system";

/**
 * What this deployment is allowed to show.
 *
 * The default is OFF for every flag, and it stays off until the server answers.
 * That direction is deliberate: a flag that defaults to on would render the
 * agent surfaces for a moment on every load and then tear them away, and an
 * instance whose backend cannot answer at all would show surfaces it cannot
 * serve. Hidden-until-confirmed fails towards the quieter board.
 */
const DEFAULT_FLAGS: FeatureFlags = { agents: false };

const FeatureFlagsContext = createContext<FeatureFlags>(DEFAULT_FLAGS);

export const FeatureFlagsProvider = ({
  children,
  value,
}: {
  children: ReactNode;
  /**
   * Pins the flags instead of asking the server. Tests use it to state the
   * deployment shape they are describing; production never passes it.
   */
  value?: FeatureFlags;
}) => {
  const [flags, setFlags] = useState<FeatureFlags>(value ?? DEFAULT_FLAGS);

  useEffect(() => {
    if (value) {
      setFlags(value);
      return;
    }
    let cancelled = false;
    getFeatureFlags()
      .then((next) => {
        if (!cancelled) setFlags(next);
      })
      .catch(() => {
        // Keep the defaults. A failed lookup must not switch surfaces on.
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  const resolved = useMemo(() => flags, [flags]);
  return <FeatureFlagsContext.Provider value={resolved}>{children}</FeatureFlagsContext.Provider>;
};

export const useFeatureFlags = (): FeatureFlags => useContext(FeatureFlagsContext);
