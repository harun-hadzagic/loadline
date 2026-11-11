// Point the app's pools at the test database before any module reads the env.
import { testUrls } from "@loadline/db/testing";

const urls = testUrls();
process.env.DATABASE_URL_APP = urls.app;
process.env.DATABASE_URL_AUTH = urls.auth;
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-0123";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
