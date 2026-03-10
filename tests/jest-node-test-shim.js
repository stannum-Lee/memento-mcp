import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
  jest,
  test
} from '@jest/globals';

const mock = {
  fn: jest.fn.bind(jest),
  method(target, propertyKey, implementation) {
    const spy = jest.spyOn(target, propertyKey);
    if (implementation) {
      spy.mockImplementation(implementation);
    }
    return spy;
  },
  restoreAll() {
    jest.restoreAllMocks();
  }
};

export {
  afterAll as after,
  afterEach,
  beforeAll as before,
  beforeEach,
  describe,
  it,
  mock,
  test
};