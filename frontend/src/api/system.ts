import { api } from "./client";
import { updateInfoSchema, type UpdateChannel, type UpdateInfo } from "@excalidash/domain/shared";

export type { UpdateChannel, UpdateInfo } from "@excalidash/domain/shared";

export const getUpdateInfo = async (channel: UpdateChannel): Promise<UpdateInfo> => {
  const response = await api.get<UpdateInfo>("/system/update", {
    params: { channel },
  });
  return updateInfoSchema.parse(response.data);
};
