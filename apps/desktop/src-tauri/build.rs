fn main() {
    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .file("src/macos_dictation.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .compile("falcondeck_macos_dictation");
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,Speech");
        println!("cargo:rerun-if-changed=src/macos_dictation.m");
        println!("cargo:rerun-if-changed=src/dictation_events.h");
    }

    tauri_build::build()
}
