export const config = {
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret",
  jwtAdminSecret: process.env.JWT_ADMIN_SECRET ?? "dev-admin-secret",
  blockCypherToken: process.env.BLOCKCYPHER_TOKEN ?? "",
  blockCypherCoin: process.env.BLOCKCYPHER_COIN ?? "bcy",
  ethereumRpcUrl: process.env.ETHEREUM_RPC_URL ?? "",
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  fromEmail: process.env.FROM_EMAIL ?? "noreply@cryptvest.example",
  usdtContractAddress: process.env.USDT_CONTRACT_ADDRESS ?? "0xdAC17F958D2ee523a2206206994597C13D831ec7",
};
