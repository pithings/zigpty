/**
 * Android/Bionic errno compatibility shim.
 *
 * musl's libc uses __errno_location() to access per-thread errno.
 * Android's Bionic uses __errno() with the same signature: () -> int*.
 *
 * This shim is always linked into musl builds. On real musl Linux,
 * musl's libc.so provides __errno_location so this weak definition
 * is overridden, and the weak __errno reference is never called.
 * On Android/Bionic, __errno resolves from Bionic and our weak
 * __errno_location provides the bridge.
 */
__attribute__((weak)) extern int *__errno(void);

__attribute__((weak)) int *__errno_location(void) {
    return __errno();
}
