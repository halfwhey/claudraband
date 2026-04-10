package tmuxctl

import (
	"strings"
	"testing"
	"time"
)

func TestNewSessionCapture(t *testing.T) {
	sess, err := NewSession("allagent-test", 80, 24, "/tmp", []string{"bash", "-c", "echo ALLAGENT_OK; sleep 3"})
	if err != nil {
		t.Fatal(err)
	}
	defer sess.Kill()

	time.Sleep(500 * time.Millisecond)

	if !sess.Alive() {
		t.Fatal("session not alive")
	}

	out, err := sess.CapturePane(CaptureOpts{WithEscapes: false})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "ALLAGENT_OK") {
		t.Fatalf("expected ALLAGENT_OK in capture, got: %q", out)
	}
}

func TestSendLine(t *testing.T) {
	sess, err := NewSession("allagent-send-test", 80, 24, "/tmp", []string{"bash"})
	if err != nil {
		t.Fatal(err)
	}
	defer sess.Kill()

	time.Sleep(300 * time.Millisecond)

	if err := sess.SendLine("echo SEND_TEST_OK"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)

	out, err := sess.CapturePane(CaptureOpts{WithEscapes: false})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "SEND_TEST_OK") {
		t.Fatalf("expected SEND_TEST_OK in capture, got: %q", out)
	}
}
