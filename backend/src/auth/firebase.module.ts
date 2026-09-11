import {
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  applicationDefault,
  cert,
  deleteApp,
  getApps,
  initializeApp,
  type App,
} from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import { decodeFirebaseServiceAccount } from './firebase-service-account.js';
import {
  FIREBASE_AUTH,
  FirebaseIdentityService,
} from './firebase-identity.service.js';

export { FIREBASE_AUTH } from './firebase-identity.service.js';
export const FIREBASE_MESSAGING = Symbol('FIREBASE_MESSAGING');

const FIREBASE_APP_NAME = 'musicmute-auth';
const FIREBASE_APP = Symbol('FIREBASE_APP');

interface ManagedFirebaseApp {
  app: App;
  owned: boolean;
}

const firebaseAppProvider: Provider<ManagedFirebaseApp> = {
  provide: FIREBASE_APP,
  inject: [ConfigService],
  useFactory: (config: ConfigService): ManagedFirebaseApp => {
    const projectId = config.getOrThrow<string>('FIREBASE_PROJECT_ID');
    const existing = getApps().find((app) => app.name === FIREBASE_APP_NAME);
    if (existing) {
      if (existing.options.projectId !== projectId)
        throw new Error(
          'Existing Firebase Admin app project does not match FIREBASE_PROJECT_ID',
        );
      return { app: existing, owned: false };
    }
    const encodedServiceAccount = config.get<string>(
      'FIREBASE_SERVICE_ACCOUNT_BASE64',
    );
    return {
      app: initializeApp(
        {
          credential: encodedServiceAccount
            ? cert(
                decodeFirebaseServiceAccount(encodedServiceAccount, projectId),
              )
            : applicationDefault(),
          projectId,
        },
        FIREBASE_APP_NAME,
      ),
      owned: true,
    };
  },
};

@Injectable()
class FirebaseAppLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(FIREBASE_APP) private readonly managed: ManagedFirebaseApp,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.managed.owned) await deleteApp(this.managed.app);
  }
}

const firebaseAuthProvider: Provider<Auth> = {
  provide: FIREBASE_AUTH,
  inject: [FIREBASE_APP],
  useFactory: (managed: ManagedFirebaseApp): Auth => getAuth(managed.app),
};

const firebaseMessagingProvider: Provider<Messaging> = {
  provide: FIREBASE_MESSAGING,
  inject: [FIREBASE_APP],
  useFactory: (managed: ManagedFirebaseApp): Messaging =>
    getMessaging(managed.app),
};

@Module({
  imports: [ConfigModule],
  providers: [
    firebaseAppProvider,
    firebaseAuthProvider,
    firebaseMessagingProvider,
    FirebaseAppLifecycle,
    FirebaseIdentityService,
  ],
  exports: [FIREBASE_AUTH, FIREBASE_MESSAGING, FirebaseIdentityService],
})
export class FirebaseModule {}
