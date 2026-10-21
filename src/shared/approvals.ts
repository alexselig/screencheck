import { z } from "zod";

export const screenApprovalSchema = z.object({
  version: z.string().min(1).max(200),
  screenId: z.string().min(1).max(200),
  approvedAt: z.iso.datetime(),
});

export const setApprovalInputSchema = z.object({
  version: z.string().min(1).max(200),
  screenId: z.string().min(1).max(200),
  approved: z.boolean(),
  // Approve even though some fixes on the screen are not verified yet.
  override: z.boolean().optional(),
});

export type ScreenApproval = z.infer<typeof screenApprovalSchema>;
export type SetApprovalInput = z.infer<typeof setApprovalInputSchema>;

export function isApproved(
  approvals: readonly ScreenApproval[],
  version: string,
  screenId: string,
) {
  return approvals.some(
    (item) => item.version === version && item.screenId === screenId,
  );
}
