export enum Asset {
  BTC = "BTC",
  USDT = "USDT",
}

export enum Network {
  BTC = "BTC",
  ERC20 = "ERC20",
  TRC20 = "TRC20",
}

export enum KycStatus {
  PENDING = "PENDING",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
}

export enum Role {
  USER = "USER",
  ADMIN = "ADMIN",
}

export enum StakePlanType {
  FLEXIBLE = "FLEXIBLE",
  LOCKED = "LOCKED",
}

export enum StakeStatus {
  ACTIVE = "ACTIVE",
  MATURED = "MATURED",
  WITHDRAWN = "WITHDRAWN",
}

export enum StakeRequestStatus {
  PENDING = "PENDING",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
}

export enum DepositStatus {
  PENDING = "PENDING",
  CONFIRMED = "CONFIRMED",
}

export enum WithdrawalStatus {
  PENDING = "PENDING",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  PAID = "PAID",
}

export enum WithdrawalSourceType {
  PRINCIPAL = "PRINCIPAL",
  EARNINGS = "EARNINGS",
}

export enum TicketStatus {
  OPEN = "OPEN",
  PENDING = "PENDING",
  CLOSED = "CLOSED",
}

export enum ChatRole {
  USER = "USER",
  ADMIN = "ADMIN",
}

export const SUPPORTED_ASSET_NETWORKS: Record<Asset, Network[]> = {
  [Asset.BTC]: [Network.BTC],
  [Asset.USDT]: [Network.ERC20],
};

export const KYC_GATED_ACTIONS = {
  deposit: false,
  stake: true,
  withdraw: true,
} as const;
