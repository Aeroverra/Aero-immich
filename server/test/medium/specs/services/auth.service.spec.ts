import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { hash } from 'bcrypt';
import { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { AuthType, UserMetadataKey } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { ClusterGroupRepository } from 'src/repositories/cluster-group.repository';
import { ConfigRepository } from 'src/repositories/config.repository';
import { CryptoRepository } from 'src/repositories/crypto.repository';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { SessionRepository } from 'src/repositories/session.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository';
import { TelemetryRepository } from 'src/repositories/telemetry.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { DB } from 'src/schema';
import { AuthService } from 'src/services/auth.service';
import { requirePrivateMode } from 'src/utils/access';
import { mediumFactory, newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(AuthService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      ClusterGroupRepository,
      ConfigRepository,
      CryptoRepository,
      DatabaseRepository,
      SessionRepository,
      SystemMetadataRepository,
      UserRepository,
    ],
    mock: [LoggingRepository, StorageRepository, EventRepository, TelemetryRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AuthService.name, () => {
  describe('adminSignUp', () => {
    it(`should sign up the admin`, async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const dto = { name: 'Admin', email: 'admin@immich.cloud', password: 'password' };

      await expect(sut.adminSignUp(dto)).resolves.toEqual(
        expect.objectContaining({
          id: expect.any(String),
          email: dto.email,
          name: dto.name,
          isAdmin: true,
        }),
      );
    });
  });

  describe('login', () => {
    it('should reject an incorrect password', async () => {
      const { sut, ctx } = setup();
      const password = 'password';
      const passwordHashed = await hash(password, 10);
      const { user } = await ctx.newUser({ password: passwordHashed });
      const dto = { email: user.email, password: 'wrong-password' };

      await expect(sut.login(dto, mediumFactory.loginDetails())).rejects.toThrow('Incorrect email or password');
    });

    it('should accept a correct password and return a login response', async () => {
      const { sut, ctx } = setup();
      const password = 'password';
      const passwordHashed = await hash(password, 10);
      const { user } = await ctx.newUser({ password: passwordHashed });
      const dto = { email: user.email, password };

      await expect(sut.login(dto, mediumFactory.loginDetails())).resolves.toEqual({
        accessToken: expect.any(String),
        isAdmin: user.isAdmin,
        isOnboarded: false,
        name: user.name,
        profileImagePath: user.profileImagePath,
        userId: user.id,
        userEmail: user.email,
        shouldChangePassword: user.shouldChangePassword,
      });
    });
  });

  describe('logout', () => {
    it('should logout', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      await expect(sut.logout(auth, AuthType.Password)).resolves.toEqual({
        successful: true,
        redirectUri: '/auth/login?autoLaunch=0',
      });
    });

    it('should cleanup the session', async () => {
      const { sut, ctx } = setup();
      const sessionRepo = ctx.get(SessionRepository);
      const eventRepo = ctx.getMock(EventRepository);
      const { user } = await ctx.newUser();
      const { session } = await ctx.newSession({ userId: user.id });
      const auth = factory.auth({ session, user });
      eventRepo.emit.mockResolvedValue();

      await expect(sessionRepo.get(session.id)).resolves.toEqual(expect.objectContaining({ id: session.id }));
      await expect(sut.logout(auth, AuthType.Password)).resolves.toEqual({
        successful: true,
        redirectUri: '/auth/login?autoLaunch=0',
      });
      await expect(sessionRepo.get(session.id)).resolves.toBeUndefined();
    });
  });

  describe('changePassword', () => {
    it('should change the password and login with it', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const dto = { password: 'password', newPassword: 'new-password' };
      const passwordHashed = await hash(dto.password, 10);
      const { user } = await ctx.newUser({ password: passwordHashed });
      const auth = factory.auth({ user });

      const response = await sut.changePassword(auth, dto);
      expect(response).toEqual(
        expect.objectContaining({
          id: user.id,
          email: user.email,
        }),
      );
      expect((response as any).password).not.toBeDefined();

      await expect(
        sut.login({ email: user.email, password: dto.newPassword }, mediumFactory.loginDetails()),
      ).resolves.toBeDefined();
    });

    it('should validate the current password', async () => {
      const { sut, ctx } = setup();
      const dto = { password: 'wrong-password', newPassword: 'new-password' };
      const passwordHashed = await hash('password', 10);
      const { user } = await ctx.newUser({ password: passwordHashed });
      const auth = factory.auth({ user });

      const response = sut.changePassword(auth, dto);
      await expect(response).rejects.toThrow(BadRequestException);
      await expect(response).rejects.toThrow('Wrong password');
    });
  });
  describe('private mode', () => {
    const pinCode = '123456';
    const metadata = { adminRoute: false, sharedLinkRoute: false, uri: '/assets' };

    const newPrivateUser = async (ctx: ReturnType<typeof setup>['ctx']) => {
      const { user } = await ctx.newUser({ pinCode: await hash(pinCode, 10) });
      const { session } = await ctx.newSession({ userId: user.id });
      const auth = factory.auth({ session, user });
      // sessionInsert stores sha256(id) as the token, so the bearer token is the raw session id
      const headers = { authorization: `Bearer ${session.id}` };
      return { user, session, auth, headers };
    };

    it('should reject enabling without a session token', async () => {
      const { sut } = setup();
      await expect(sut.enablePrivateMode(factory.auth(), { pinCode })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should reject a wrong pin code', async () => {
      const { sut, ctx } = setup();
      const { auth } = await newPrivateUser(ctx);
      await expect(sut.enablePrivateMode(auth, { pinCode: '000000' })).rejects.toThrow('Wrong PIN code');
    });

    it('should reject a user without a pin code', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { session } = await ctx.newSession({ userId: user.id });
      const auth = factory.auth({ session, user });
      await expect(sut.enablePrivateMode(auth, { pinCode })).rejects.toThrow('User does not have a PIN code');
    });

    it('should enable, report, and disable private mode on the session', async () => {
      const { sut, ctx } = setup();
      const { auth, headers, session } = await newPrivateUser(ctx);

      await expect(sut.getAuthStatus(auth)).resolves.toEqual(
        expect.objectContaining({ privateMode: false, privateModeExpiresAt: undefined, isElevated: false }),
      );

      await sut.enablePrivateMode(auth, { pinCode });
      const enabled = await sut.authenticate({ headers, queryParams: {}, metadata });
      expect(enabled.session).toEqual({ id: session.id, hasElevatedPermission: false, privateMode: true });

      const status = await sut.getAuthStatus(enabled);
      expect(status.privateMode).toBe(true);
      expect(status.isElevated).toBe(false);
      const expiresAt = DateTime.fromISO(status.privateModeExpiresAt!);
      expect(expiresAt.diffNow('minutes').minutes).toBeGreaterThan(25);
      expect(expiresAt.diffNow('minutes').minutes).toBeLessThanOrEqual(30);

      await sut.disablePrivateMode(enabled);
      const disabled = await sut.authenticate({ headers, queryParams: {}, metadata });
      expect(disabled.session).toEqual({ id: session.id, hasElevatedPermission: false, privateMode: false });
    });

    it('should keep private mode independent from the locked folder unlock', async () => {
      const { sut, ctx } = setup();
      const { auth, headers } = await newPrivateUser(ctx);

      await sut.unlockSession(auth, { pinCode });
      const unlocked = await sut.authenticate({ headers, queryParams: {}, metadata });
      expect(unlocked.session).toEqual(expect.objectContaining({ hasElevatedPermission: true, privateMode: false }));

      await sut.enablePrivateMode(auth, { pinCode });
      await sut.lockSession(auth);
      const locked = await sut.authenticate({ headers, queryParams: {}, metadata });
      expect(locked.session).toEqual(expect.objectContaining({ hasElevatedPermission: false, privateMode: true }));
    });

    it('should treat an expired timestamp as off', async () => {
      const { sut, ctx } = setup();
      const { headers, session } = await newPrivateUser(ctx);
      await ctx
        .get(SessionRepository)
        .update(session.id, { privateModeExpiresAt: DateTime.now().minus({ minutes: 1 }).toJSDate() });

      const result = await sut.authenticate({ headers, queryParams: {}, metadata });
      expect(result.session?.privateMode).toBe(false);
    });

    it('should slide the expiry by the configured timeout when close to expiring', async () => {
      const { sut, ctx } = setup();
      const { user, headers, session } = await newPrivateUser(ctx);
      await ctx.get(UserRepository).upsertMetadata(user.id, {
        key: UserMetadataKey.Preferences,
        value: { privateMode: { timeoutMinutes: 120 } },
      });
      await ctx
        .get(SessionRepository)
        .update(session.id, { privateModeExpiresAt: DateTime.now().plus({ minutes: 2 }).toJSDate() });

      const result = await sut.authenticate({ headers, queryParams: {}, metadata });
      expect(result.session?.privateMode).toBe(true);

      const updated = await ctx.get(SessionRepository).get(session.id);
      const minutesLeft = DateTime.fromJSDate(updated!.privateModeExpiresAt!).diffNow('minutes').minutes;
      expect(minutesLeft).toBeGreaterThan(115);
    });

    it('should not slide the expiry when far from expiring', async () => {
      const { sut, ctx } = setup();
      const { headers, session } = await newPrivateUser(ctx);
      const expiresAt = DateTime.now().plus({ minutes: 20 }).toJSDate();
      await ctx.get(SessionRepository).update(session.id, { privateModeExpiresAt: expiresAt });

      await sut.authenticate({ headers, queryParams: {}, metadata });
      const updated = await ctx.get(SessionRepository).get(session.id);
      expect(updated!.privateModeExpiresAt!.getTime()).toBe(expiresAt.getTime());
    });

    it('should use the configured timeout when enabling', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newPrivateUser(ctx);
      await ctx.get(UserRepository).upsertMetadata(user.id, {
        key: UserMetadataKey.Preferences,
        value: { privateMode: { timeoutMinutes: 5 } },
      });

      await sut.enablePrivateMode(auth, { pinCode });
      const status = await sut.getAuthStatus(auth);
      const minutes = DateTime.fromISO(status.privateModeExpiresAt!).diffNow('minutes').minutes;
      expect(minutes).toBeGreaterThan(4);
      expect(minutes).toBeLessThanOrEqual(5);
    });

    it('should clear private mode on every session when the pin code is reset', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newPrivateUser(ctx);
      const { session: other } = await ctx.newSession({ userId: user.id });
      await sut.enablePrivateMode(auth, { pinCode });
      await sut.enablePrivateMode(factory.auth({ session: other, user }), { pinCode });

      await sut.resetPinCode(auth, { pinCode });

      const sessionRepo = ctx.get(SessionRepository);
      await expect(sessionRepo.get(auth.session!.id)).resolves.toEqual(
        expect.objectContaining({ privateModeExpiresAt: null, pinExpiresAt: null }),
      );
      await expect(sessionRepo.get(other.id)).resolves.toEqual(
        expect.objectContaining({ privateModeExpiresAt: null, pinExpiresAt: null }),
      );
    });

    it('should reject the private-only checks without the flag', () => {
      expect(() => requirePrivateMode(factory.auth())).toThrow(UnauthorizedException);
      expect(() => requirePrivateMode(factory.auth({ session: { privateMode: false } }))).toThrow(
        UnauthorizedException,
      );
      expect(() => requirePrivateMode(factory.auth({ session: { privateMode: true } }))).not.toThrow();
    });
  });
});
