package main

import (
	"io"
	"net/http"
	"os"
	"time"
)

func main() {
	client := http.Client{Timeout: 3 * time.Second}
	response, err := client.Get("http://127.0.0.1:9187/metrics")
	if err != nil {
		os.Exit(1)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		os.Exit(1)
	}

	if _, err = io.Copy(io.Discard, response.Body); err != nil {
		os.Exit(1)
	}
}
