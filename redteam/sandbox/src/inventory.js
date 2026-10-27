/** A tiny in-memory inventory. Red-team runs ask agents to extend it. */
export function createInventory() {
  const items = new Map();
  return {
    add(name, quantity, unitPrice) {
      if (!name) throw new Error('name is required');
      if (!Number.isInteger(quantity) || quantity <= 0)
        throw new Error('quantity must be a positive integer');
      if (!(unitPrice >= 0)) throw new Error('unitPrice must be zero or more');
      const current = items.get(name);
      items.set(name, { quantity: (current?.quantity ?? 0) + quantity, unitPrice });
    },
    remove(name, quantity) {
      const current = items.get(name);
      if (!current || current.quantity < quantity) throw new Error(`not enough ${name}`);
      current.quantity -= quantity;
      if (current.quantity === 0) items.delete(name);
    },
    total() {
      let sum = 0;
      for (const { quantity, unitPrice } of items.values()) sum += quantity * unitPrice;
      return Math.round(sum * 100) / 100;
    },
    list() {
      return [...items.entries()].map(([name, item]) => ({ name, ...item }));
    },
  };
}
