import { api } from "./client";

export type InstructionContext = { id: string; frameElementId: string };
export type InstructionApprovalStatus = "none" | "approved" | "expired";

export const getInstructionContexts = async (drawingId: string): Promise<InstructionContext[]> =>
  (await api.get<{ contexts: InstructionContext[] }>(`/drawings/${drawingId}/agent/instruction-contexts`)).data.contexts;

export const getInstructionApproval = async (
  drawingId: string,
  contextId: string,
  elementId: string,
): Promise<{ status: InstructionApprovalStatus }> =>
  (await api.get(`/drawings/${drawingId}/agent/contexts/${contextId}/instructions/${elementId}/approval`)).data;

export const approveInstruction = async (
  drawingId: string,
  contextId: string,
  elementId: string,
  expectedClosureHash: string,
) =>
  api.post(`/drawings/${drawingId}/agent/contexts/${contextId}/instructions/${elementId}/approval`, {
    expectedClosureHash,
  });

export const previewInstructionApproval = async (
  drawingId: string,
  contextId: string,
  elementId: string,
): Promise<{ closure: { closureHash: string; canonical: string } }> =>
  (await api.get(`/drawings/${drawingId}/agent/contexts/${contextId}/instructions/${elementId}/approval-preview`)).data;
