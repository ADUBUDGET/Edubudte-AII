function money(value) {
  return `R${Math.abs(Number(value) || 0).toFixed(2)}`;
}

function budgetSummary(monthlyBudget, totalSpent) {
  const budget = Number(monthlyBudget) || 0;
  const spent = Number(totalSpent) || 0;
  if (budget <= 0) return "No monthly budget is set on your account yet.";

  const remaining = budget - spent;
  const balance = remaining >= 0
    ? `${money(remaining)} remains.`
    : `You are ${money(remaining)} over budget.`;
  return `Your monthly budget is ${money(budget)} and your logged spending is ${money(spent)}. ${balance}`;
}

function buildOfflineChatReply({ message, monthlyBudget, totalSpent, categories = [] }) {
  const prompt = String(message || "").toLowerCase();
  const summary = budgetSummary(monthlyBudget, totalSpent);
  const opening = "AI replies are temporarily unavailable because the assistant service needs a valid key. I can still share your saved account information. ";

  if (/grocery|groceries|food|shopping|basket/.test(prompt)) {
    return `${opening}I can't provide reliable live grocery prices in chat right now. Search the Shop for current listings and add items to your basket. ${summary}`;
  }

  if (/save|saving|spend|spending|expense|expenses/.test(prompt)) {
    const largestCategory = categories.find(category => Number(category.total) > 0);
    const insight = largestCategory
      ? `Your largest logged category is ${largestCategory.category} at ${money(largestCategory.total)}. Reviewing recent purchases in that category may help you find a saving.`
      : "You haven't logged purchases by category yet, so there isn't enough spending history for a category tip.";
    return `${opening}${summary} ${insight}`;
  }

  if (/budget|plan|monthly/.test(prompt)) {
    const nextStep = Number(monthlyBudget) > 0
      ? "Tell me about any fixed costs you want included in a plan."
      : "Set a monthly budget in the Budget page to start tracking your remaining amount.";
    return `${opening}${summary} ${nextStep}`;
  }

  return `${opening}${summary} For full AI chat, the site administrator needs to configure a valid GROQ_API_KEY.`;
}

module.exports = { buildOfflineChatReply, budgetSummary };