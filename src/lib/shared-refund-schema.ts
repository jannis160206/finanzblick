import { z } from "zod";

export const sharedSettlementFields = {
  sharedRefundFor: z.string().min(1).max(2000).optional(),
  sharedRefundUnlinked: z.boolean().optional(),
  sharedRepaymentFor: z.string().min(1).max(2000).optional(),
  sharedPaidAmount: z.number().finite().min(0).max(1_000_000_000).multipleOf(0.01).optional(),
};

export type SharedSettlementFields = {
  sharedRefundFor?: string;
  sharedRefundUnlinked?: boolean;
  sharedRepaymentFor?: string;
  sharedPaidAmount?: number;
};
