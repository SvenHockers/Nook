package logging

import (
	"bytes"
	"sync"
	"testing"
)

func TestWrapAndOversizedWrite(t *testing.T) {
	b := NewRingBuffer(5)
	b.Write([]byte("abc"))
	b.Write([]byte("defg"))
	if string(b.Bytes()) != "cdefg" {
		t.Fatal(string(b.Bytes()))
	}
	b.Write([]byte("0123456789"))
	if string(b.Bytes()) != "56789" {
		t.Fatal(string(b.Bytes()))
	}
	copy := b.Bytes()
	copy[0] = 'x'
	if bytes.Equal(copy, b.Bytes()) {
		t.Fatal("snapshot aliases buffer")
	}
}
func TestConcurrent(t *testing.T) {
	b := NewRingBuffer(100)
	var wg sync.WaitGroup
	for i := 0; i < 15; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				b.Write([]byte("abc"))
				b.Bytes()
			}
		}()
	}
	wg.Wait()
	if len(b.Bytes()) != 100 {
		t.Fatal("unbounded buffer")
	}
}
