package api

import (
	"crypto/tls"
	"crypto/x509"
	"net"
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/api/state"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	grpcTest "google.golang.org/grpc/interop/grpc_testing"
	"google.golang.org/grpc/reflection"
)

func startMutualTLSGrpcServer(t *testing.T, clientCA *x509.CertPool) string {
	t.Helper()
	_, _, serverCert := issueCert(t, "grpc-server")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer(grpc.Creds(credentials.NewTLS(&tls.Config{
		Certificates: []tls.Certificate{serverCert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    clientCA,
		MinVersion:   tls.VersionTLS12,
	})))
	grpcTest.RegisterTestServiceServer(server, executionGrpcServer{})
	reflection.Register(server)
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)
	return listener.Addr().String()
}

func mutualTLSGrpcRequest(target, certPath, keyPath string) model.GrpcRequest {
	return model.GrpcRequest{
		Target:         target,
		FullMethod:     "grpc.testing.TestService/EmptyCall",
		Message:        "{}",
		UseReflection:  true,
		UseTLS:         true,
		TimeoutMs:      5000,
		ClientCertPath: certPath,
		ClientKeyPath:  keyPath,
	}
}

func TestGrpcPresentsClientCertificateForMutualTLS(t *testing.T) {
	clientCerts = newClientCertCache()
	certPEM, keyPEM, _ := issueCert(t, "grpc-client")
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(certPEM)
	target := startMutualTLSGrpcServer(t, pool)
	dir := t.TempDir()
	certPath := writeTemp(t, dir, "client.crt", certPEM)
	keyPath := writeTemp(t, dir, "client.key", keyPEM)

	resp := sendGrpcRequest(t.Context(), mutualTLSGrpcRequest(target, certPath, keyPath), state.New(), nil)
	if resp.Error != "" || resp.GrpcCode != "OK" {
		t.Fatalf("with client certificate: code=%q error=%q", resp.GrpcCode, resp.Error)
	}

	combined := writeTemp(t, dir, "client.pem", append(append([]byte{}, certPEM...), keyPEM...))
	resp = sendGrpcRequest(t.Context(), mutualTLSGrpcRequest(target, combined, ""), state.New(), nil)
	if resp.Error != "" || resp.GrpcCode != "OK" {
		t.Fatalf("with combined PEM: code=%q error=%q", resp.GrpcCode, resp.Error)
	}

	discovered := discoverGrpcServices(t.Context(), mutualTLSGrpcRequest(target, certPath, keyPath))
	if discovered.Error != "" || len(discovered.Services) == 0 {
		t.Fatalf("reflection over mTLS: %#v", discovered)
	}
}

func TestGrpcMutualTLSServerRejectsCallWithoutCertificate(t *testing.T) {
	clientCerts = newClientCertCache()
	certPEM, _, _ := issueCert(t, "grpc-client")
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(certPEM)
	target := startMutualTLSGrpcServer(t, pool)

	resp := sendGrpcRequest(t.Context(), mutualTLSGrpcRequest(target, "", ""), state.New(), nil)
	if resp.Error == "" && resp.GrpcCode == "OK" {
		t.Fatal("server accepted a call without a client certificate")
	}
}

func TestGrpcClientCertificateErrorsAreReported(t *testing.T) {
	clientCerts = newClientCertCache()
	resp := sendGrpcRequest(t.Context(), mutualTLSGrpcRequest("127.0.0.1:1", "/does/not/exist.crt", ""), state.New(), nil)
	if !strings.Contains(resp.Error, "client certificate") {
		t.Fatalf("error = %q", resp.Error)
	}
}
