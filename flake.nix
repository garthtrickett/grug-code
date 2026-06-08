{
  description = "Local-first language acquisition dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forEachSystem = f: nixpkgs.lib.genAttrs supportedSystems (system: f (import nixpkgs {
        inherit system;
        config.allowUnfree = true;
      }));
    in
    {
      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            bashInteractive
            pkg-config
          ];

          buildInputs = with pkgs; [
            nodejs_22
            bun
            esbuild
            chromium
            unzip
            curl
            python3
            
            # Rust Compiler Toolchain
            cargo
            rustc
            
            # Tauri 2.0 System Dependencies
            webkitgtk_4_1
            gtk3
            cairo
            gdk-pixbuf
            glib
            dbus
            openssl
            librsvg
            libsoup_3
          ];

          shellHook = ''
            echo "🚀 Grug Code Development Environment Loaded"
            echo "Bun: $(bun --version)"
            echo "Node: $(node --version)"
            echo "Cargo: $(cargo --version)"
            
            # Playwright Configurations
            export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
            export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${pkgs.chromium}/bin/chromium"
            
            # Configure Tauri shared library bindings
            export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath (with pkgs; [
              webkitgtk_4_1
              gtk3
              cairo
              gdk-pixbuf
              glib
              dbus
              openssl
              librsvg
              libsoup_3
            ])}:$LD_LIBRARY_PATH"
          '';
        };
      });
    };
}
