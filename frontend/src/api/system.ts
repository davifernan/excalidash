import { api } from "./client";

export type UpdateChannel = "stable" | "prerelease";

export type UpdateInfo = {
  currentVersion: string | null;
  channel: UpdateChannel;
  outboundEnabled: boolean;
  latestVersion: string | null;
  latestUrl: string | null;
  publishedAt: string | null;
  isUpdateAvailable: boolean | null;
  error?: string;
};

export const getUpdateInfo = async (channel: UpdateChannel): Promise<UpdateInfo> => {
  const response = await api.get<UpdateInfo>("/system/update", {
    params: { channel },
  });
  return response.data;
};

export type FeatureFlags = {
  agents: boolean;
};

export const getFeatureFlags = async (): Promise<FeatureFlags> => {
  const response = await api.get<FeatureFlags>("/system/features");
  return response.data;
};
