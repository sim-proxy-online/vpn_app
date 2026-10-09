//go:build tools

package simcore

// Якорь зависимости: gomobile bind требует golang.org/x/mobile в go.mod.
import _ "golang.org/x/mobile/bind"
