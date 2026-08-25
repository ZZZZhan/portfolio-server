# PENDING 交易不计入

场外申购按金额录入时份额待净值确认，若计入 Completion 与盈亏会在份额未定时虚增进度与收益；决定仅 COMPLETED 且 shares/price 非空的交易参与 calc.ts 的 isEffective 计算，PENDING 仅在 22:00 补份额后重算快照，保证账实一致。
