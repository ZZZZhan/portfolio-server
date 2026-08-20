// jest 用的 CommonJS mock：@thallesp/nestjs-better-auth 是纯 ESM，
// ts-jest(CommonJS) 无法直接 import，单元测试里这些符号无需真实实现。
module.exports = {
  AuthModule: class {
    static forRoot() {
      return { module: this };
    }
  },
  AuthGuard: class {},
  AuthService: class {},
  Session: () => () => null,
  UserSession: undefined,
  AllowAnonymous: () => () => undefined,
  OptionalAuth: () => () => undefined,
  Roles: () => () => undefined,
  OrgRoles: () => () => undefined,
  RequireActiveOrg: () => () => undefined,
  UserHasPermission: () => () => undefined,
  MemberHasPermission: () => () => undefined,
};
