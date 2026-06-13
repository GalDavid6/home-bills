function computeCycle(input) {
  const waterShare = Math.ceil(input.waterTotal / 4);
  const kids = input.kids.map((k) => {
    const consumption = k.current - k.prev;
    const electricity = Math.ceil(consumption * input.tariff);
    const water = waterShare;
    return { name: k.name, consumption, electricity, water, total: electricity + water };
  });
  return {
    period: input.period,
    waterTotal: input.waterTotal,
    tariff: input.tariff,
    waterShare,
    kids,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeCycle };
}
if (typeof window !== 'undefined') {
  window.computeCycle = computeCycle;
}
