const test = require("node:test");
const assert = require("node:assert/strict");
const { buildOfflineChatReply, budgetSummary } = require("../chat-fallback");

test("budget summary uses the saved budget and spending", () => {
  assert.equal(budgetSummary(5000, 1250), "Your monthly budget is R5000.00 and your logged spending is R1250.00. R3750.00 remains.");
});

test("budget summary reports an over-budget amount", () => {
  assert.equal(budgetSummary(1000, 1250), "Your monthly budget is R1000.00 and your logged spending is R1250.00. You are R250.00 over budget.");
});

test("budget prompts get account facts and an actionable next step", () => {
  const reply = buildOfflineChatReply({ message: "Help plan my monthly budget", monthlyBudget: 3000, totalSpent: 500 });
  assert.match(reply, /R2500\.00 remains/);
  assert.match(reply, /fixed costs/);
});

test("grocery prompts direct students to current Shop listings without inventing prices", () => {
  const reply = buildOfflineChatReply({ message: "Make a grocery list", monthlyBudget: 2000, totalSpent: 400 });
  assert.match(reply, /can't provide reliable live grocery prices/);
  assert.match(reply, /Search the Shop/);
  assert.doesNotMatch(reply, /R\d+\.\d{2} for/);
});

test("saving prompts use the largest recorded category", () => {
  const reply = buildOfflineChatReply({
    message: "How can I save money?",
    monthlyBudget: 2000,
    totalSpent: 600,
    categories: [{ category: "Food", total: 350 }, { category: "Transport", total: 250 }],
  });
  assert.match(reply, /Food at R350\.00/);
});