module.exports = {
  preset: 'react-native',
  moduleNameMapper: {
    // Rendering the real app tree pulls in navigation, which imports a PNG.
    '\\.(png|jpg|jpeg|gif|webp|svg)$': '<rootDir>/__mocks__/fileMock.js',
  },
};
