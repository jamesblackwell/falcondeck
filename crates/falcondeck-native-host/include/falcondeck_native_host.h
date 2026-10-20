#ifndef FALCONDECK_NATIVE_HOST_H
#define FALCONDECK_NATIVE_HOST_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Every returned JSON string is Rust-owned and must be freed once with
 * fd_native_string_free. A successful reply includes "ok":true. Failures
 * include "ok":false and a human-readable "error". Calls may block: invoke
 * start/status/shutdown on a worker thread, outside a Rust Tokio runtime. */
char *fd_native_start(const char *config_json);
char *fd_native_status(void);
char *fd_native_shutdown(void);
void fd_native_string_free(char *value);

/* Run before constructing the GUI. -1 is an ordinary app launch; any other
 * value is the process exit code for a completed reserved stdio helper. */
int32_t fd_native_dispatch_helper(void);

#ifdef __cplusplus
}
#endif
#endif
