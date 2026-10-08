import {
  appStateSchema,
  type Category,
  type Transaction,
} from "../../src/lib/types";
import { pocketFixture } from "./pocket-state";

export function budgetBooking(
  id: string,
  category: Category,
  amount: number,
  date = "2026-10-05",
): Transaction {
  return {
    id,
    date,
    amount,
    description: `Budgetbeispiel ${id}`,
    category,
    categoryOverride: true,
    fixedCost: false,
    includeInPlan: true,
    reviewed: true,
    bank: "Revolut",
    pocket: null,
  };
}

export function budgetFixture() {
  const state = pocketFixture();
  state.transactions = [
    budgetBooking("food", "Lebensmittel", -320),
    budgetBooking("food-refund", "Lebensmittel", 50),
    {
      ...budgetBooking("shared-fuel", "Mobilität", -200),
      sharedWithRaphael: true,
    },
    {
      ...budgetBooking("raphael", "Transfer intern", 100),
      description: "Raphael Piber",
    },
    budgetBooking("gifts", "Geschenke & Spenden", -13),
    budgetBooking("leisure-refund", "Freizeit", 30),
    budgetBooking("restaurant", "Restaurants", -15),
    budgetBooking("postage", "Porto & Versand", -25),
    { ...budgetBooking("excluded", "Shopping", -100), includeInPlan: false },
    { ...budgetBooking("fixed", "Mobilität", -50), fixedCost: true },
    budgetBooking("future", "Lebensmittel", -500, "2026-10-09"),
    budgetBooking("previous", "Lebensmittel", -500, "2026-09-05"),
    budgetBooking("transfer", "Transfer intern", -300),
    budgetBooking("salary", "Gehalt", 3000),
  ];
  return appStateSchema.parse(state);
}
