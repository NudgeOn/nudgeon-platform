import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  output: "standalone",
};

// 콘솔 i18n (U-12): 로케일은 쿠키/Accept-Language, 메시지는 src/messages. 라우팅 접두어는 쓰지 않는다.
export default createNextIntlPlugin("./src/i18n/request.ts")(nextConfig);
