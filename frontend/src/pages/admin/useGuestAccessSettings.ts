import { useState } from "react";
import * as api from "../../api";

type GuestCapabilities = {
  uploadFiles: boolean;
  viewComments: boolean;
  agentContextContribute: boolean;
};

/**
 * The instance-wide ceiling from NIL-615/NIL-633. Boards read this to explain
 * why a board toggle is locked (GuestCapabilitiesSection.tsx) but only an
 * admin can change it, through this hook.
 */
export const useGuestAccessSettings = (
  isAdmin: boolean,
  setError: (message: string) => void,
  setSuccess: (message: string) => void,
) => {
  const [capabilities, setCapabilities] = useState<GuestCapabilities | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!isAdmin) return;
    setLoading(true);
    try {
      const response = await api.api.get<{ capabilities: GuestCapabilities }>(
        "/auth/guest-capabilities",
      );
      setCapabilities(response.data.capabilities);
    } catch (err: unknown) {
      let message = "Failed to load guest access settings";
      if (api.isAxiosError(err)) {
        message = err.response?.data?.message || err.response?.data?.error || message;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const toggle = async (key: keyof GuestCapabilities) => {
    if (!isAdmin || !capabilities) return;
    setLoading(true);
    setError("");
    setSuccess("");
    try {
      const response = await api.api.put<{ capabilities: GuestCapabilities }>(
        "/auth/guest-capabilities",
        { [key]: !capabilities[key] },
      );
      setCapabilities(response.data.capabilities);
      const messages: Record<keyof GuestCapabilities, [string, string]> = {
        uploadFiles: [
          "Guests can be allowed to upload files",
          "Guest file uploads are disabled instance-wide",
        ],
        viewComments: [
          "Guests can be allowed to see comments",
          "Guest comment visibility is disabled instance-wide",
        ],
        agentContextContribute: [
          "Guests can be allowed to contribute to Agent Contexts",
          "Guest contribution to Agent Contexts is disabled instance-wide",
        ],
      };
      const [enabledMessage, disabledMessage] = messages[key];
      setSuccess(response.data.capabilities[key] ? enabledMessage : disabledMessage);
    } catch (err: unknown) {
      let message = "Failed to update guest access settings";
      if (api.isAxiosError(err)) {
        message = err.response?.data?.message || err.response?.data?.error || message;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return {
    capabilities,
    loading,
    load,
    toggleUploadFiles: () => toggle("uploadFiles"),
    toggleViewComments: () => toggle("viewComments"),
    toggleAgentContextContribute: () => toggle("agentContextContribute"),
  };
};
